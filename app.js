import { Chess, validateFen } from './chess.js';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const game = new Chess();
let orientation = 'w';            // 'w' | 'b'
let selected = null;              // selected square, e.g. 'e2'
let legalCache = [];              // verbose legal moves from selected
let redoStack = [];
let evals = [null];               // recorded eval per ply: { cp (white-relative), label } or null
let lastMove = null;              // { from, to }
let bestMoveUci = null;
let hintMove = null;              // { from, to } squares highlighted by Hint
let hintTimer = null;
let pvLines = [[], [], []];       // per-multipv SAN strings
let pvScores = [null, null, null]; // raw {type:'cp'|'mate', value} side-to-move relative
let searchDepth = 0;
// Displayed eval (bar + number): live search result when fresh, else last
// recorded eval for this position (instant response on navigation).
let shownCp = null;
let shownLabel = '…';
// Search lifecycle: guards against stale output from a stopped search and
// against the analysis search hijacking a play-mode reply search.
let analysisSeq = 0;              // id of the latest analysis request
let liveSeq = -1;                 // seq that produced pvScores[0]
let searching = false;            // a 'go' is in flight
let staleBestmoveExpected = false;

const $ = (id) => document.getElementById(id);
const boardEl = $('board'), arrowLine = $('bestArrow'), promoPicker = $('promoPicker');

const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const FILES = 'abcdefgh';

/* ------------------------------------------------------------------ */
/* Engine (Stockfish in a Web Worker)                                  */
/* ------------------------------------------------------------------ */
const ENGINE_LOCAL = 'engine/stockfish-19-lite-single.js';
const ENGINE_FALLBACK = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
let engine = null;
let engineReady = false;
let engineFailed = false;
let analyzeTimer = null;

const DIFFICULTY = [
  { skill: 0, depth: 6 },
  { skill: 6, depth: 10 },
  { skill: 11, depth: 13 },
  { skill: 16, depth: 17 },
  { skill: 20, depth: 21 },
];

const play = { active: false, humanColor: 'w', thinking: false };

function setStatus(state, text) {
  const el = $('engineStatus');
  el.className = 'engine-status ' + state;
  $('engineStatusText').textContent = text;
}

function spawnEngine(path) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(path);
    } catch (e) {
      reject(e);
      return;
    }
    const timeout = setTimeout(() => reject(new Error('engine start timeout')), 15000);
    worker.onmessage = (e) => {
      const lines = String(e.data).split('\n');
      for (const line of lines) {
        if (line.startsWith('uciok')) {
          clearTimeout(timeout);
          wireEngine(worker);
          resolve(worker);
          return;
        }
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      reject(e?.error || new Error('engine worker error'));
    };
    worker.postMessage('uci');
  });
}

async function initEngine() {
  setStatus('loading', 'Loading engine…');
  try {
    await spawnEngine(ENGINE_LOCAL);
  } catch (e) {
    console.warn('Local engine failed, trying CDN fallback:', e);
    setStatus('loading', 'Loading engine (CDN)…');
    try {
      await spawnEngine(ENGINE_FALLBACK);
    } catch (e2) {
      console.error('Engine failed:', e2);
      engineFailed = true;
      setStatus('error', 'Engine unavailable');
      $('engineMeta').textContent = 'Engine could not start. Board play still works; analysis is disabled.';
      return;
    }
  }
  setStatus('ready', 'Stockfish 19 ready');
  engineReady = true;
  engine.postMessage('setoption name MultiPV value 3');
  analyze();
}

function wireEngine(worker) {
  engine = worker;
  engine.onmessage = onEngineLine;
  engine.onerror = () => {};
}

function send(cmd) {
  try { engine.postMessage(cmd); }
  catch (e) { console.warn('engine send failed:', cmd, e); }
}

function onEngineLine(e) {
  const raw = String(e.data);
  const lines = raw.split('\n');
  for (const line of lines) handleEngineLine(line.trim());
}

function handleEngineLine(line) {
  if (!line) return;
  if (line.startsWith('info ') && line.includes(' pv ')) {
    if (staleBestmoveExpected) return; // leftover from a stopped search
    const m = line.match(/depth (\d+).*multipv (\d+).*score (cp|mate) (-?\d+).* pv ([a-h1-8qrnb ]+)/);
    if (m) {
      const depth = +m[1], n = +m[2], kind = m[3], val = +m[4];
      const pvUci = m[5].trim().split(/\s+/);
      if (depth < searchDepth - 3) { searchDepth = depth; pvLines = [[], [], []]; }
      searchDepth = Math.max(searchDepth, depth);
      if (n >= 1 && n <= 3) {
        pvLines[n - 1] = pvToSan(pvUci);
        pvScores[n - 1] = { type: kind, value: val };
        if (n === 1) {
          liveSeq = analysisSeq;
          shownCp = toWhiteCp(pvScores[0]);
          shownLabel = fmtScore(pvScores[0]);
        }
      }
      renderAnalysis();
    }
    const meta = line.match(/depth (\d+).*nodes (\d+).*nps (\d+).*time (\d+)/);
    if (meta) {
      $('engineMeta').textContent =
        `depth ${meta[1]} · nodes ${Number(meta[2]).toLocaleString()} · ${Number(meta[3]).toLocaleString()} nps · ${(meta[4] / 1000).toFixed(2)}s`;
    }
    return;
  }
  if (line.startsWith('bestmove')) {
    searching = false;
    $('thinkBadge').classList.add('hidden');
    if (staleBestmoveExpected) { staleBestmoveExpected = false; return; } // leftover from a stopped search
    const parts = line.split(/\s+/);
    const bm = parts[1];
    if (bm && bm !== '(none)') {
      bestMoveUci = bm;
      recordEval();
      renderAnalysis();
      drawArrow();
    }
    if (play.active && play.thinking) {
      play.thinking = false;
      updatePlayUI();
      if (bm && bm !== '(none)' && !game.isGameOver() && game.turn() !== play.humanColor) {
        doUciMove(bm);
      }
    }
  }
}

function resetAnalysisPanel() {
  analysisSeq++;
  clearTimeout(analyzeTimer);
  bestMoveUci = null;
  pvLines = [[], [], []];
  pvScores = [null, null, null];
  searchDepth = 0;
  liveSeq = -1;
  // NOTE: shownCp/shownLabel are intentionally kept: the previous eval stays
  // visible until the fresh search (or a recorded eval) replaces it.
  renderAnalysis();
  drawArrow();
  $('thinkBadge').classList.remove('hidden');
}

function analyze() {
  if (!engineReady || engineFailed) return;
  if (play.active && play.thinking) { enginePlayMove(); return; } // don't hijack the reply search
  resetAnalysisPanel();
  // Instant response: show the recorded eval for this position (if any)
  // while the fresh search runs — e.g. when stepping through moves.
  const h = evals[game.history().length];
  if (h) { shownCp = h.cp; shownLabel = h.label; renderAnalysis(); }
  const seq = analysisSeq;
  if (searching) { staleBestmoveExpected = true; send('stop'); }
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    if (seq !== analysisSeq) return;
    const depth = +$('depthSelect').value || 18;
    send('stop');
    send('setoption name Skill Level value 20');
    send('position fen ' + game.fen());
    send('go depth ' + depth);
    searching = true;
  }, 120);
}

function enginePlayMove() {
  if (!engineReady || engineFailed) return;
  const d = DIFFICULTY[+$('difficulty').value] || DIFFICULTY[1];
  play.thinking = true;
  updatePlayUI();
  resetAnalysisPanel();
  send('stop');
  send('setoption name Skill Level value ' + d.skill);
  send('position fen ' + game.fen());
  send('go depth ' + d.depth);
  searching = true;
}

// Start an engine reply when it is the engine's turn in play mode.
// Returns true when a reply search was started (caller must not analyze).
function maybeEngineReply() {
  if (play.active && !game.isGameOver() && game.turn() !== play.humanColor) {
    if (searching) staleBestmoveExpected = true;
    enginePlayMove();
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Eval helpers (all bars/scores shown White-relative)                 */
/* ------------------------------------------------------------------ */
function toWhiteCp(score) {
  if (!score) return null;
  const turn = game.turn();
  if (score.type === 'mate') {
    const wMate = turn === 'w' ? score.value : -score.value;
    return wMate > 0 ? 100000 - (100 - Math.min(99, Math.abs(score.value))) : -100000;
  }
  return turn === 'w' ? score.value : -score.value;
}

function fmtScore(score) {
  if (!score) return '…';
  const w = game.turn() === 'w' ? score.value : -score.value;
  if (score.type === 'mate') {
    const mateIn = score.value;
    const wMate = game.turn() === 'w' ? mateIn : -mateIn;
    return (wMate > 0 ? '' : '-') + '#' + Math.abs(mateIn);
  }
  const v = w / 100;
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

// White's share of the eval bar (0..100). Tanh curve: sensitive to small
// edges around equality, saturating towards won positions.
function evalShare(whiteCp) {
  if (whiteCp == null) return 50;
  if (whiteCp >= 90000) return 100;
  if (whiteCp <= -90000) return 0;
  return 50 + 50 * Math.tanh(whiteCp / 350);
}

function recordEval() {
  if (!pvScores[0] || liveSeq !== analysisSeq) return; // only fresh results
  const cp = toWhiteCp(pvScores[0]);
  if (cp == null) return;
  evals[game.history().length] = { cp, label: fmtScore(pvScores[0]) };
  drawChart();
}

/* ------------------------------------------------------------------ */
/* Board rendering                                                     */
/* ------------------------------------------------------------------ */
function squareColor(sq) {
  const f = FILES.indexOf(sq[0]), r = +sq[1];
  return (f + r) % 2 === 0 ? 'dark' : 'light';
}

function renderBoard() {
  boardEl.innerHTML = '';
  let kingInCheck = null;
  if (game.isCheck()) {
    for (const row of game.board()) for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === game.turn()) { kingInCheck = cell.square; break; }
    }
  }
  for (let ri = 0; ri < 8; ri++) {
    for (let fi = 0; fi < 8; fi++) {
      const f = orientation === 'w' ? fi : 7 - fi;
      const r = orientation === 'w' ? 8 - ri : ri + 1;
      const sqName = FILES[f] + r;
      const piece = game.get(sqName);
      const d = document.createElement('div');
      d.className = 'sq ' + squareColor(sqName);
      d.dataset.sq = sqName;
      if (lastMove && (sqName === lastMove.from || sqName === lastMove.to)) d.classList.add('lastmove');
      if (selected === sqName) d.classList.add('selected');
      if (hintMove && sqName === hintMove.from) d.classList.add('hint-from');
      if (hintMove && sqName === hintMove.to) d.classList.add('hint-to');
      if (sqName === kingInCheck) d.classList.add('check');
      const t = selected ? legalCache.find((m) => m.to === sqName) : null;
      if (t) d.classList.add(t.captured ? 'capture' : 'target');

      // coordinates: rank down the left file, file along the bottom rank
      if (fi === 0) { const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = sqName[1]; d.appendChild(c); }
      if (ri === 7) { const c = document.createElement('span'); c.className = 'coord file'; c.textContent = sqName[0]; d.appendChild(c); }

      if (piece) {
        const p = document.createElement('span');
        p.className = 'piece ' + piece.color;
        p.textContent = GLYPH[piece.type];
        p.draggable = canMovePiece(piece.color);
        p.dataset.sq = sqName;
        p.addEventListener('pointerdown', (ev) => { ev.preventDefault(); onSquarePress(sqName); });
        p.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', sqName);
          p.classList.add('dragging');
        });
        p.addEventListener('dragend', () => p.classList.remove('dragging'));
        d.appendChild(p);
      }
      d.addEventListener('click', () => onSquarePress(sqName));
      d.addEventListener('dragover', (ev) => ev.preventDefault());
      d.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const from = ev.dataTransfer.getData('text/plain');
        if (from) attemptMove(from, sqName);
      });
      boardEl.appendChild(d);
    }
  }
  drawArrow();
}

function canMovePiece(color) {
  if (game.isGameOver()) return false;
  if (play.active) return color === play.humanColor && color === game.turn();
  return color === game.turn();
}

function onSquarePress(sq) {
  hidePromo();
  clearHintState();
  if (selected && sq !== selected) {
    if (legalCache.some((m) => m.to === sq)) {
      attemptMove(selected, sq);
      return;
    }
  }
  const piece = game.get(sq);
  if (piece && canMovePiece(piece.color)) {
    if (selected === sq) {
      selected = null; legalCache = [];
    } else {
      selected = sq;
      legalCache = game.moves({ square: sq, verbose: true });
    }
    renderBoard();
  } else {
    selected = null; legalCache = [];
    renderBoard();
  }
}

function attemptMove(from, to) {
  const opts = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!opts.length) { selected = null; legalCache = []; renderBoard(); return; }
  if (opts.some((m) => m.promotion)) {
    showPromo(from, to, game.turn());
    return;
  }
  commitMove(from, to);
}

function commitMove(from, to, promotion) {
  let mv = null;
  try {
    mv = game.move({ from, to, promotion });
  } catch { mv = null; }
  if (!mv) { selected = null; legalCache = []; renderBoard(); return; }
  selected = null; legalCache = [];
  lastMove = { from: mv.from, to: mv.to };
  redoStack = [];
  const ply = game.history().length;
  evals.length = ply;
  evals.push(null);
  afterPositionChanged();
}

function doUciMove(uci) {
  commitMove(uci.slice(0, 2), uci.slice(2, 4), uci.slice(4) || undefined);
}

/* Promotion picker */
function showPromo(from, to, color) {
  selected = from;
  renderBoard();
  const pieces = color === 'w'
    ? [['q', '♛'], ['r', '♜'], ['b', '♝'], ['n', '♞']]
    : [['q', '♛'], ['r', '♜'], ['b', '♝'], ['n', '♞']];
  promoPicker.innerHTML = '';
  for (const [p, glyph] of pieces) {
    const b = document.createElement('button');
    b.textContent = glyph;
    b.className = color;
    b.style.color = color === 'w' ? '#f8fafc' : '#101418';
    b.style.textShadow = color === 'w' ? '0 0 2px #000,1px 1px 0 #000' : '0 0 2px #e2e8f0';
    b.onclick = (ev) => { ev.stopPropagation(); hidePromo(); commitMove(from, to, p); };
    promoPicker.appendChild(b);
  }
  const f = FILES.indexOf(to[0]);
  const r = +to[1];
  const x = orientation === 'w' ? f : 7 - f;
  const y = orientation === 'w' ? 8 - r : r - 1;
  promoPicker.style.left = `calc(${(x / 8) * 100}% + 4px)`;
  promoPicker.style.top = `calc(${(y / 8) * 100}% + 4px)`;
  promoPicker.classList.remove('hidden');
}
function hidePromo() { promoPicker.classList.add('hidden'); }

/* Best-move arrow */
function sqToXY(sq) {
  const f = FILES.indexOf(sq[0]);
  const r = +sq[1];
  if (orientation === 'w') return { x: f + 0.5, y: 8 - r + 0.5 };
  return { x: 7 - f + 0.5, y: r - 1 + 0.5 };
}
function drawArrow() {
  if (!bestMoveUci || bestMoveUci.length < 4) { arrowLine.setAttribute('visibility', 'hidden'); return; }
  try {
    const a = sqToXY(bestMoveUci.slice(0, 2));
    const b = sqToXY(bestMoveUci.slice(2, 4));
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const shorten = 0.42;
    arrowLine.setAttribute('x1', a.x + (dx / len) * 0.12);
    arrowLine.setAttribute('y1', a.y + (dy / len) * 0.12);
    arrowLine.setAttribute('x2', b.x - (dx / len) * shorten);
    arrowLine.setAttribute('y2', b.y - (dy / len) * shorten);
    arrowLine.setAttribute('visibility', 'visible');
  } catch { arrowLine.setAttribute('visibility', 'hidden'); }
}

/* ------------------------------------------------------------------ */
/* Side panel rendering                                                */
/* ------------------------------------------------------------------ */
function pvToSan(pvUci) {
  const tmp = new Chess(game.fen());
  const out = [];
  for (const u of pvUci) {
    try {
      const mv = tmp.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
      if (!mv) break;
      out.push(mv.san);
    } catch { break; }
  }
  return out;
}

function renderAnalysis() {
  $('evalBig').textContent = shownLabel;
  $('evalBarLabel').textContent = shownLabel;
  const pct = evalShare(shownCp);
  $('winChanceText').textContent = `White ${pct.toFixed(0)}% · Black ${(100 - pct).toFixed(0)}%`;
  $('bestMoveText').textContent = bestMoveUci ? uciToSan(bestMoveUci) + ` (${bestMoveUci})` : '—';

  // eval bar (white share)
  const share = pct;
  $('evalBarWhite').style.height = share + '%';
  const lbl = $('evalBarLabel');
  lbl.style.bottom = `calc(${Math.max(3, Math.min(97, share))}% - 9px)`;

  const list = $('pvList');
  list.innerHTML = '';
  let any = false;
  for (let i = 0; i < 3; i++) {
    if (!pvLines[i]?.length) continue;
    any = true;
    const li = document.createElement('li');
    const ev = document.createElement('span');
    ev.className = 'pv-eval';
    ev.textContent = fmtScore(pvScores[i]);
    li.appendChild(ev);
    li.appendChild(document.createTextNode(pvLines[i].join(' ')));
    const dep = document.createElement('span');
    dep.className = 'pv-depth';
    dep.textContent = 'depth ' + searchDepth;
    li.appendChild(dep);
    list.appendChild(li);
  }
  if (!any) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="muted">Analyzing…</span>';
    list.appendChild(li);
  }
}

function uciToSan(uci) {
  try {
    const tmp = new Chess(game.fen());
    const mv = tmp.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return mv ? mv.san : uci;
  } catch { return uci; }
}

function renderMoves() {
  const el = $('moveList');
  const hist = game.history({ verbose: true });
  const cur = hist.length; // current ply (redo undone moves aren't in history)
  el.innerHTML = '';
  if (!hist.length) {
    el.innerHTML = '<span class="muted">No moves yet — play something!</span>';
    return;
  }
  for (let i = 0; i < hist.length; i += 2) {
    const num = document.createElement('span');
    num.className = 'move-num';
    num.textContent = (i / 2 + 1) + '.';
    el.appendChild(num);
    for (let j = i; j < Math.min(i + 2, hist.length); j++) {
      const b = document.createElement('button');
      b.className = 'move-btn' + (j === cur - 1 ? ' current' : '');
      b.textContent = hist[j].san;
      b.dataset.ply = j + 1;
      b.onclick = () => gotoPly(j + 1);
      el.appendChild(b);
    }
  }
  el.scrollTop = el.scrollHeight;
}

function renderStatus() {
  let t;
  if (game.isCheckmate()) {
    t = 'Checkmate · ' + (game.turn() === 'w' ? 'Black wins' : 'White wins');
  } else if (game.isStalemate()) t = 'Draw · stalemate';
  else if (game.isThreefoldRepetition()) t = 'Draw · threefold repetition';
  else if (game.isInsufficientMaterial()) t = 'Draw · insufficient material';
  else if (game.isDraw()) t = 'Draw · fifty-move rule';
  else t = (game.turn() === 'w' ? 'White' : 'Black') + ' to move' + (game.isCheck() ? ' · check!' : '');
  if (play.active && play.thinking) t += ' · engine thinking…';
  $('gameStatus').textContent = t;
  const fenBox = $('fenInput');
  if (document.activeElement !== fenBox) fenBox.value = game.fen();
  const pgnBox = $('pgnInput');
  if (document.activeElement !== pgnBox) pgnBox.value = game.pgn();
  $('btnUndo').disabled = !game.history().length;
  $('btnRedo').disabled = !redoStack.length;
}

function drawChart() {
  const cv = $('evalChart');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#2b3648';
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  const clamp = (v) => {
    const c = v == null ? 0 : v.cp;
    return Math.max(-800, Math.min(800, c >= 90000 ? 800 : c <= -90000 ? -800 : c));
  };
  const pts = evals.map((v) => H / 2 - (clamp(v) / 800) * (H / 2 - 6));
  if (pts.length < 2) return;
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((y, i) => {
    const x = (i / Math.max(1, pts.length - 1)) * (W - 8) + 4;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  // current position dot
  const cx = ((pts.length - 1) / Math.max(1, pts.length - 1)) * (W - 8) + 4;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, pts[pts.length - 1], 4, 0, 7); ctx.fill();
}

function afterPositionChanged(opts = {}) {
  clearHintState(); // a hint never survives a position change
  renderBoard();
  renderMoves();
  renderStatus();
  drawChart();
  // In play mode the engine replies instead of a competing analysis search.
  // Navigation (undo/redo/goto) never triggers a reply.
  if (opts.reply !== false && maybeEngineReply()) return;
  analyze();
}

/* Hint: pulse the best-move squares + flash the arrow so the suggestion
   is unmistakable (it is more than the persistent analysis display). */
function clearHintState() {
  hintMove = null;
  clearTimeout(hintTimer);
  arrowLine.classList.remove('flash');
}

function clearHint() {
  if (!hintMove) { arrowLine.classList.remove('flash'); return; }
  clearHintState();
  renderBoard();
}

function showHint() {
  if (game.isGameOver()) { $('bestMoveText').textContent = '— game over'; return; }
  if (engineFailed) { $('bestMoveText').textContent = 'engine unavailable'; return; }
  if (!bestMoveUci || bestMoveUci.length < 4) {
    analyze(); // ensure a search is running; press Hint again when it lands
    $('thinkBadge').classList.remove('hidden');
    return;
  }
  hintMove = { from: bestMoveUci.slice(0, 2), to: bestMoveUci.slice(2, 4) };
  $('bestMoveText').textContent = uciToSan(bestMoveUci) + ` (${bestMoveUci})`;
  renderBoard();
  drawArrow();
  arrowLine.classList.remove('flash');
  void arrowLine.getBoundingClientRect(); // restart the flash animation
  arrowLine.classList.add('flash');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(clearHint, 4200);
  const wrap = document.querySelector('.board-wrap');
  if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Navigation */
function gotoPly(target) {
  while (game.history().length > target) {
    const m = game.undo();
    if (m) redoStack.push(m); else break;
  }
  while (game.history().length < target && redoStack.length) {
    const m = redoStack.pop();
    try { game.move({ from: m.from, to: m.to, promotion: m.promotion }); }
    catch { break; }
  }
  // rebuild lastMove
  const h = game.history({ verbose: true });
  lastMove = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : null;
  afterPositionChanged({ reply: false });
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */
function newGame() {
  game.reset();
  redoStack = [];
  evals = [null];
  lastMove = null;
  selected = null; legalCache = [];
  play.thinking = false;
  afterPositionChanged();
}

function updatePlayUI() {
  $('btnPlayStart').disabled = play.active;
  $('btnPlayStop').disabled = !play.active;
  const names = ['Beginner · ~600', 'Casual · ~1000', 'Club · ~1400', 'Expert · ~1800', 'Master · ~2300'];
  $('playStatus').textContent = play.active
    ? `Playing as ${play.humanColor === 'w' ? 'White' : 'Black'} vs ${names[+$('difficulty').value]}${play.thinking ? ' — engine thinking…' : ''}`
    : 'Analysis mode — engine suggests, you move both sides.';
  renderStatus();
}

$('btnNew').onclick = newGame;
$('btnFlip').onclick = () => { orientation = orientation === 'w' ? 'b' : 'w'; renderBoard(); };
$('btnUndo').onclick = () => {
  if (play.active) {
    // take back full round (engine + human)
    if (game.history().length) { const m = game.undo(); if (m) redoStack.push(m); }
    if (game.turn() !== play.humanColor && game.history().length) { const m = game.undo(); if (m) redoStack.push(m); }
    play.thinking = false;
  } else if (game.history().length) {
    const m = game.undo();
    if (m) redoStack.push(m);
  }
  const h = game.history({ verbose: true });
  lastMove = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : null;
  afterPositionChanged({ reply: false });
  updatePlayUI();
};
$('btnRedo').onclick = () => {
  if (!redoStack.length) return;
  const m = redoStack.pop();
  try { game.move({ from: m.from, to: m.to, promotion: m.promotion }); } catch { return; }
  const h = game.history({ verbose: true });
  lastMove = { from: h[h.length - 1].from, to: h[h.length - 1].to };
  afterPositionChanged();
};
$('btnHint').onclick = showHint;
$('btnPlayBest').onclick = () => { if (bestMoveUci) doUciMove(bestMoveUci); };

$('depthSelect').onchange = analyze;

$('btnPlayStart').onclick = () => {
  play.active = true;
  play.humanColor = $('humanColor').value;
  play.thinking = false;
  redoStack = [];
  updatePlayUI();
  afterPositionChanged();
};
$('btnPlayStop').onclick = () => {
  play.active = false; play.thinking = false;
  send('stop');
  $('thinkBadge').classList.add('hidden');
  updatePlayUI();
  analyze();
};

$('btnFenLoad').onclick = () => {
  const fen = $('fenInput').value.trim();
  const v = validateFen(fen);
  if (!v.ok) { alert('Invalid FEN: ' + v.error); return; }
  try { game.load(fen); } catch (e) { alert('Invalid FEN: ' + e.message); return; }
  redoStack = []; evals = [null]; lastMove = null;
  selected = null; legalCache = [];
  play.thinking = false;
  afterPositionChanged();
};
$('btnFenCopy').onclick = () => copyText(game.fen());
$('btnStartpos').onclick = () => {
  game.reset(); redoStack = []; evals = [null]; lastMove = null;
  selected = null; legalCache = [];
  play.thinking = false;
  afterPositionChanged();
};
$('btnPgnLoad').onclick = () => {
  try {
    game.loadPgn($('pgnInput').value);
  } catch (e) { alert('Invalid PGN: ' + e.message); return; }
  redoStack = []; evals = [null];
  selected = null; legalCache = [];
  play.thinking = false;
  const h = game.history({ verbose: true });
  lastMove = h.length ? { from: h[h.length - 1].from, to: h[h.length - 1].to } : null;
  afterPositionChanged();
};
$('btnPgnCopy').onclick = () => copyText(game.pgn());

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}

document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'ArrowLeft') $('btnUndo').click();
  else if (e.key === 'ArrowRight') $('btnRedo').click();
  else if (e.key === 'f' || e.key === 'F') $('btnFlip').click();
});
document.addEventListener('click', (e) => {
  if (!promoPicker.classList.contains('hidden') && !promoPicker.contains(e.target)) hidePromo();
});

/* ------------------------------------------------------------------ */
afterPositionChanged();
updatePlayUI();
initEngine();

// hook for automated smoke tests
window.__analyzer = { game, commitMove, gotoPly, get bestMoveUci() { return bestMoveUci; } };
