const express = require('express'), http = require('http'), path = require('path');
const { WebSocketServer } = require('ws'), { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '2kb' }));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (q, r) => r.send('ok'));

/* ---------- База данных (Supabase Postgres) ---------- */
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 })
  : null;
if (db) {
  db.on('error', e => console.error('pg error:', e.message));
  db.query(`create table if not exists scores(
      id bigserial primary key,
      name text not null,
      level int not null,
      time int not null,
      players int not null default 1,
      created_at timestamptz not null default now())`)
    .then(() => db.query('alter table scores enable row level security'))
    .then(() => console.log('db ready'))
    .catch(e => console.error('db init failed:', e.message));
} else {
  console.log('DATABASE_URL не задан: рейтинг отключён');
}

const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, n);
async function saveScore(name, level, time, players) {
  if (!db) return;
  try {
    await db.query('insert into scores(name,level,time,players) values($1,$2,$3,$4)', [name, level, time, players]);
  } catch (e) { console.error('score error:', e.message); }
}

app.get('/api/top', async (q, r) => {
  if (!db) return r.json([]);
  try {
    const x = await db.query('select name,level,time,players from scores order by level desc, time asc limit 10');
    r.json(x.rows);
  } catch (e) { r.json([]); }
});

app.post('/api/score', async (q, r) => {
  const b = q.body || {};
  const level = Math.floor(+b.level), time = Math.floor(+b.time);
  if (!(level >= 1 && level <= 99 && time >= 5 && time <= 3600)) return r.sendStatus(400);
  await saveScore(clean(b.name, 12) || 'Денис', level, time, 1);
  r.sendStatus(204);
});

/* ---------- Комнаты (WebSocket) ---------- */
const srv = http.createServer(app);
const wss = new WebSocketServer({ server: srv, maxPayload: 8192 });
const rooms = new Map();
const num = v => (Number.isFinite(+v) ? +v : 0);

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { players: new Map(), host: 0, lv: 1, run: null, nid: 1 }; rooms.set(code, r); }
  return r;
}
function bc(r, o, except) {
  const s = JSON.stringify(o);
  for (const [id, p] of r.players) if (id !== except && p.ws.readyState === 1) p.ws.send(s);
}

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});

  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d.t !== 'string') return;

    if (d.t === 'join') {
      if (ws.r) return;
      const code = clean(d.room, 8).replace(/ /g, '').toUpperCase() || 'ABC';
      const r = getRoom(code);
      if (r.players.size >= 4) { ws.send(JSON.stringify({ t: 'full' })); return; }
      const id = r.nid++;
      const name = clean(d.name, 12) || 'Игрок';
      ws.r = r; ws.pid = id; ws.code = code;
      r.players.set(id, { ws, name });
      if (!r.host) r.host = id;
      ws.send(JSON.stringify({
        t: 'joined', id, host: r.host === id, lv: r.lv,
        players: [...r.players].map(([i, p]) => ({ id: i, name: p.name })),
        run: r.run
      }));
      bc(r, { t: 'pj', id, name }, id);
      return;
    }

    const r = ws.r;
    if (!r) return;
    const id = ws.pid, isHost = r.host === id;

    switch (d.t) {
      case 'start':
        if (!isHost) return;
        r.run = { seed: 1 + Math.floor(Math.random() * 2147483000), lv: r.lv, items: [], cans: [], lives: 3 };
        bc(r, { t: 'start', seed: r.run.seed, lv: r.lv, lives: 3 });
        break;
      case 'p':
        bc(r, { t: 'p', id, x: num(d.x), z: num(d.z), yaw: num(d.yaw), hid: d.hid ? 1 : 0, inv: num(d.inv), run: d.run ? 1 : 0 }, id);
        break;
      case 'g':
        if (isHost && Array.isArray(d.a) && d.a.length < 16) bc(r, { t: 'g', a: d.a }, id);
        break;
      case 'item':
        if (r.run && Number.isInteger(d.i) && !r.run.items.includes(d.i)) r.run.items.push(d.i);
        bc(r, { t: 'item', id, i: d.i }, id);
        break;
      case 'can':
        if (r.run && Number.isInteger(d.i) && !r.run.cans.includes(d.i)) r.run.cans.push(d.i);
        bc(r, { t: 'can', id, i: d.i }, id);
        break;
      case 'pot':
        bc(r, { t: 'pot', x: num(d.x), z: num(d.z), vx: num(d.vx), vz: num(d.vz) }, id);
        break;
      case 'noise':
        bc(r, { t: 'noise', x: num(d.x), z: num(d.z) }, id);
        break;
      case 'caught':
        if (isHost) bc(r, { t: 'caught', id: d.id }, id);
        break;
      case 'lives':
        if (isHost) { if (r.run) r.run.lives = num(d.n); bc(r, { t: 'lives', n: num(d.n) }, id); }
        break;
      case 'over':
        if (isHost) { r.run = null; bc(r, { t: 'over', why: String(d.why || '').slice(0, 100) }, id); }
        break;
      case 'win': {
        if (!r.run) return;
        const time = Math.floor(+d.time), lv = r.run.lv;
        const names = [...r.players.values()].map(p => p.name).join(', ').slice(0, 40);
        r.run = null; r.lv = lv + 1;
        if (time >= 5 && time <= 3600) saveScore(names, lv, time, r.players.size);
        bc(r, { t: 'win' }, id);
        break;
      }
    }
  });

  ws.on('close', () => {
    const r = ws.r;
    if (!r) return;
    r.players.delete(ws.pid);
    if (!r.players.size) { rooms.delete(ws.code); return; }
    bc(r, { t: 'pl', id: ws.pid });
    if (r.host === ws.pid) {
      r.host = r.players.keys().next().value;
      bc(r, { t: 'host', id: r.host });
    }
  });
});

// Render закрывает «молчащие» соединения, поэтому пингуем
setInterval(() => {
  wss.clients.forEach(w => {
    if (!w.alive) return w.terminate();
    w.alive = false;
    try { w.ping(); } catch (e) {}
  });
}, 25000);

const port = process.env.PORT || 3000;
srv.listen(port, '0.0.0.0', () => console.log('listening on ' + port));
