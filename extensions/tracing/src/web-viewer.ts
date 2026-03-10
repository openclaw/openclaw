import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonlTraceWriter } from "./storage-jsonl.js";

const TRACES_PREFIX = "/plugins/tracing";

function parseUrl(raw?: string): URL | null {
  try {
    return new URL(raw ?? "", "http://localhost");
  } catch {
    return null;
  }
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
  return true;
}

function html(res: ServerResponse, body: string) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
  return true;
}

export function createTracingHttpHandler(writer: JsonlTraceWriter) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = parseUrl(req.url);
    if (!url) return false;

    const path = url.pathname;

    // API: list dates
    if (path === `${TRACES_PREFIX}/api/dates`) {
      return json(res, { dates: writer.listDates() });
    }

    // API: get spans by date
    if (path === `${TRACES_PREFIX}/api/spans`) {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      return json(res, { date, spans: writer.readByDate(date) });
    }

    // Serve the viewer HTML
    if (path === TRACES_PREFIX || path === `${TRACES_PREFIX}/`) {
      return html(res, VIEWER_HTML);
    }

    return false;
  };
}

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Traces</title>
<style>
  :root {
    --bg: #0d1117; --fg: #e6edf3; --border: #30363d;
    --accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
    --magenta: #bc8cff; --red: #f85149; --dim: #8b949e;
    --surface: #161b22; --surface2: #21262d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: var(--bg); color: var(--fg); font-size: 13px; line-height: 1.5; }
  .header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header select { background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-family: inherit; font-size: 13px; }
  .tabs { display: flex; gap: 2px; padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .tab { padding: 10px 16px; cursor: pointer; color: var(--dim); border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .content { padding: 16px 24px; overflow-x: auto; }
  .empty { color: var(--dim); padding: 40px; text-align: center; }

  /* Call Tree */
  .tree-node { padding: 2px 0; white-space: nowrap; }
  .tree-indent { color: var(--border); user-select: none; }
  .tree-connector { color: var(--border); user-select: none; }
  .kind-session { color: var(--accent); }
  .kind-llm_call { color: var(--yellow); }
  .kind-tool_call { color: var(--green); }
  .kind-subagent { color: var(--magenta); }
  .duration { color: var(--accent); margin-left: 8px; }
  .tokens { color: var(--dim); margin-left: 8px; }
  .tool-params { color: var(--dim); margin-left: 4px; }
  .dim { color: var(--dim); }

  /* Entity Tree */
  .entity-node { padding: 4px 0; }
  .entity-stats { color: var(--dim); padding-left: 24px; }
  .entity-stat { margin-right: 16px; }
  .stat-llm { color: var(--yellow); }
  .stat-tool { color: var(--green); }

  /* Waterfall */
  .waterfall { width: 100%; }
  .wf-row { display: flex; align-items: center; padding: 2px 0; gap: 8px; }
  .wf-label { width: 220px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; }
  .wf-bar-container { flex: 1; position: relative; height: 18px; }
  .wf-bar { position: absolute; height: 100%; border-radius: 2px; min-width: 2px; opacity: 0.85; }
  .wf-bar.kind-session { background: var(--accent); }
  .wf-bar.kind-llm_call { background: var(--yellow); }
  .wf-bar.kind-tool_call { background: var(--green); }
  .wf-bar.kind-subagent { background: var(--magenta); }
  .wf-dur { width: 60px; flex-shrink: 0; text-align: right; color: var(--accent); }

  /* Summary */
  .summary { margin-top: 16px; padding: 12px 16px; background: var(--surface); border-radius: 6px; border: 1px solid var(--border); color: var(--dim); }
  .summary strong { color: var(--fg); }
</style>
</head>
<body>
<div class="header">
  <h1>🦞 OpenClaw Traces</h1>
  <select id="dateSelect"><option>Loading...</option></select>
  <span id="spanCount" class="dim"></span>
</div>
<div class="tabs">
  <div class="tab active" data-view="call">📊 Call Tree</div>
  <div class="tab" data-view="entity">🌳 Entity Tree</div>
  <div class="tab" data-view="waterfall">⏱️ Waterfall</div>
</div>
<div class="content" id="content"></div>

<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let spans = [];
let currentView = 'call';

// Fetch
async function fetchDates() {
  const r = await fetch('/plugins/tracing/api/dates');
  return (await r.json()).dates;
}
async function fetchSpans(date) {
  const r = await fetch('/plugins/tracing/api/spans?date=' + date);
  const d = await r.json();
  return d.spans;
}

// Init
(async () => {
  const dates = await fetchDates();
  const sel = $('#dateSelect');
  sel.innerHTML = dates.length
    ? dates.map(d => '<option value="'+d+'">'+d+'</option>').join('')
    : '<option>No traces</option>';
  sel.onchange = () => load(sel.value);
  if (dates.length) load(dates[0]);
})();

async function load(date) {
  spans = await fetchSpans(date);
  $('#spanCount').textContent = spans.length + ' spans';
  render();
}

// Tabs
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  currentView = t.dataset.view;
  render();
});

function render() {
  const c = $('#content');
  if (!spans.length) { c.innerHTML = '<div class="empty">No traces for this date.</div>'; return; }
  if (currentView === 'call') c.innerHTML = renderCallTree();
  else if (currentView === 'entity') c.innerHTML = renderEntityTree();
  else c.innerHTML = renderWaterfall();
}

// Utils
function fmtDur(ms) {
  if (ms == null) return '';
  return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

const icons = { session: '🔵', llm_call: '🧠', tool_call: '🔧', subagent: '🤖' };

// Call Tree
function renderCallTree() {
  const byId = new Map(spans.map(s => [s.spanId, s]));
  const children = new Map();
  for (const s of spans) {
    if (!s.parentSpanId) continue;
    if (!children.has(s.parentSpanId)) children.set(s.parentSpanId, []);
    children.get(s.parentSpanId).push(s);
  }
  for (const [,list] of children) list.sort((a,b) => a.startMs - b.startMs);
  // Dedupe: prefer closed spans (with endMs) over open ones
  const closed = new Map();
  for (const s of spans) {
    const key = s.spanId;
    if (!closed.has(key) || s.endMs != null) closed.set(key, s);
  }
  const deduped = [...closed.values()];
  const dedupedChildren = new Map();
  for (const s of deduped) {
    if (!s.parentSpanId) continue;
    if (!dedupedChildren.has(s.parentSpanId)) dedupedChildren.set(s.parentSpanId, []);
    dedupedChildren.get(s.parentSpanId).push(s);
  }
  for (const [,list] of dedupedChildren) list.sort((a,b) => a.startMs - b.startMs);
  const roots = deduped.filter(s => !s.parentSpanId).sort((a,b) => a.startMs - b.startMs);

  let html = '';
  function renderNode(span, prefix, isLast) {
    const conn = isLast ? '└─ ' : '├─ ';
    const icon = icons[span.kind] || '●';
    let label = '';
    if (span.kind === 'session') {
      label = '<span class="kind-session">' + esc(span.agentId || 'agent') + '</span> <span class="dim">(' + esc(span.sessionKey || '') + ')</span>';
    } else if (span.kind === 'llm_call') {
      label = '<span class="kind-llm_call">llm</span> <span class="dim">[' + esc(span.provider||'') + '/' + esc(span.model||'') + ']</span>';
    } else if (span.kind === 'tool_call') {
      label = '<span class="kind-tool_call">' + esc(span.toolName || span.name) + '</span>';
      if (span.toolParams) {
        const preview = Object.entries(span.toolParams).map(([k,v]) => {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return k + '=' + (s.length > 30 ? s.slice(0,30) + '…' : s);
        }).join(', ');
        label += '<span class="tool-params">(' + esc(preview) + ')</span>';
      }
    } else if (span.kind === 'subagent') {
      label = '<span class="kind-subagent">→ ' + esc(span.childAgentId||'') + '</span> <span class="dim">(' + esc(span.childSessionKey||'') + ')</span>';
    }
    const dur = span.durationMs != null ? '<span class="duration">' + fmtDur(span.durationMs) + '</span>' : '';
    let tok = '';
    if (span.kind === 'llm_call' && (span.tokensIn || span.tokensOut)) {
      tok = '<span class="tokens">[in:' + (span.tokensIn||0) + ' out:' + (span.tokensOut||0) + ']</span>';
    }
    html += '<div class="tree-node"><span class="tree-indent">' + esc(prefix) + '</span><span class="tree-connector">' + conn + '</span>' + icon + ' ' + label + dur + tok + '</div>';
    const kids = dedupedChildren.get(span.spanId) || [];
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    kids.forEach((kid, i) => renderNode(kid, childPrefix, i === kids.length - 1));
  }
  roots.forEach((r, i) => renderNode(r, '', i === roots.length - 1));
  return html;
}

// Entity Tree
function renderEntityTree() {
  const agents = new Map();
  // Dedupe spans
  const closed = new Map();
  for (const s of spans) {
    const key = s.spanId;
    if (!closed.has(key) || s.endMs != null) closed.set(key, s);
  }
  const deduped = [...closed.values()];

  for (const s of deduped) {
    if (!s.agentId) continue;
    if (!agents.has(s.agentId)) agents.set(s.agentId, { agentId: s.agentId, sessionKey: null, children: [], tools: new Set(), models: new Set(), llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 });
    const a = agents.get(s.agentId);
    if (s.kind === 'session') { a.sessionKey = s.sessionKey; a.durationMs = s.durationMs || 0; }
    if (s.kind === 'llm_call') { a.llmCalls++; a.tokensIn += s.tokensIn||0; a.tokensOut += s.tokensOut||0; if (s.model) a.models.add(s.model); }
    if (s.kind === 'tool_call') { a.toolCalls++; if (s.toolName) a.tools.add(s.toolName); }
  }
  const childAgents = new Set();
  for (const s of deduped) {
    if (s.kind === 'subagent' && s.childAgentId) {
      const parent = agents.get(s.agentId);
      const child = agents.get(s.childAgentId);
      if (parent && child) { parent.children.push(child); childAgents.add(s.childAgentId); }
    }
  }
  const roots = [...agents.values()].filter(a => !childAgents.has(a.agentId));

  let html = '';
  function renderAgent(a, prefix, isLast) {
    const conn = isLast ? '└─ ' : '├─ ';
    const dur = a.durationMs ? '<span class="duration">' + fmtDur(a.durationMs) + '</span>' : '';
    html += '<div class="entity-node"><span class="tree-indent">' + esc(prefix) + '</span><span class="tree-connector">' + conn + '</span>🤖 <strong class="kind-session">' + esc(a.agentId) + '</strong> ' + dur + '</div>';
    const dp = prefix + (isLast ? '   ' : '│  ');
    const stats = [];
    if (a.llmCalls) stats.push('<span class="stat-llm">' + a.llmCalls + ' LLM calls</span>');
    if (a.toolCalls) stats.push('<span class="stat-tool">' + a.toolCalls + ' tool calls</span>');
    if (a.tokensIn || a.tokensOut) stats.push('<span class="dim">tokens: ' + a.tokensIn + '→' + a.tokensOut + '</span>');
    if (stats.length) html += '<div class="entity-stats"><span class="tree-indent">' + esc(dp) + '</span>' + stats.join('  ') + '</div>';
    if (a.models.size) html += '<div class="entity-stats"><span class="tree-indent">' + esc(dp) + '</span>models: <span class="kind-llm_call">' + [...a.models].map(esc).join(', ') + '</span></div>';
    if (a.tools.size) html += '<div class="entity-stats"><span class="tree-indent">' + esc(dp) + '</span>tools: <span class="kind-tool_call">' + [...a.tools].map(esc).join(', ') + '</span></div>';
    a.children.forEach((c, i) => renderAgent(c, dp, i === a.children.length - 1));
  }
  roots.forEach((r, i) => renderAgent(r, '', i === roots.length - 1));

  // Summary
  const totalAgents = agents.size;
  const totalLlm = deduped.filter(s => s.kind === 'llm_call').length;
  const totalTools = deduped.filter(s => s.kind === 'tool_call').length;
  const totalTokens = deduped.reduce((sum, s) => sum + (s.tokensIn||0) + (s.tokensOut||0), 0);
  html += '<div class="summary">Agents: <strong>' + totalAgents + '</strong> &nbsp; LLM calls: <strong>' + totalLlm + '</strong> &nbsp; Tool calls: <strong>' + totalTools + '</strong> &nbsp; Total tokens: <strong>' + totalTokens + '</strong></div>';
  return html;
}

// Waterfall
function renderWaterfall() {
  // Dedupe
  const closed = new Map();
  for (const s of spans) {
    if (!closed.has(s.spanId) || s.endMs != null) closed.set(s.spanId, s);
  }
  const deduped = [...closed.values()].filter(s => s.endMs != null);
  if (!deduped.length) return '<div class="empty">No completed spans.</div>';

  const minStart = Math.min(...deduped.map(s => s.startMs));
  const maxEnd = Math.max(...deduped.map(s => s.endMs));
  const total = maxEnd - minStart || 1;

  const kindOrder = { session: 0, llm_call: 1, subagent: 1, tool_call: 2 };
  deduped.sort((a,b) => (a.startMs - b.startMs) || ((kindOrder[a.kind]||9) - (kindOrder[b.kind]||9)));

  let html = '<div class="waterfall">';
  for (const s of deduped) {
    const left = ((s.startMs - minStart) / total * 100).toFixed(2);
    const width = Math.max(0.5, ((s.endMs - s.startMs) / total * 100));
    const label = s.kind === 'session' ? (s.agentId||'session')
      : s.kind === 'llm_call' ? 'llm [' + (s.model||'?').split('-').slice(0,2).join('-') + ']'
      : s.kind === 'subagent' ? '→' + (s.childAgentId||'?')
      : (s.toolName || s.name);
    const icon = icons[s.kind] || '●';
    html += '<div class="wf-row">'
      + '<div class="wf-label"><span class="kind-' + s.kind + '">' + icon + ' ' + esc(label) + '</span></div>'
      + '<div class="wf-bar-container"><div class="wf-bar kind-' + s.kind + '" style="left:' + left + '%;width:' + width.toFixed(2) + '%"></div></div>'
      + '<div class="wf-dur">' + fmtDur(s.durationMs) + '</div>'
      + '</div>';
  }
  html += '</div>';
  html += '<div class="summary">Total duration: <strong>' + fmtDur(total) + '</strong></div>';
  return html;
}
</script>
</body>
</html>`;
