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
    --bg: #ffffff; --fg: #1a1a2e; --border: #e0e0e0;
    --accent: #2563eb; --green: #16a34a; --yellow: #ca8a04;
    --magenta: #9333ea; --red: #dc2626; --dim: #6b7280;
    --surface: #f8f9fa; --surface2: #f0f0f0;
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
  .tree-node { padding: 2px 0; white-space: nowrap; border-radius: 3px; transition: background 1.5s ease; }
  .tree-node.new-span { background: #dcfce7; animation: fadeNewSpan 5s forwards; }
  @keyframes fadeNewSpan { 0% { background: #dcfce7; } 100% { background: transparent; } }
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

  /* Entity Graph */
  .graph-container { position: relative; width: 100%; height: 600px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
  .graph-container svg { width: 100%; height: 100%; }
  .graph-node { cursor: grab; }
  .graph-node:active { cursor: grabbing; }
  .graph-node circle { stroke-width: 2; }
  .graph-node text { font-family: inherit; font-size: 11px; fill: var(--fg); pointer-events: none; }
  .graph-node .node-stats { font-size: 9px; fill: var(--dim); }
  .graph-link { stroke: var(--border); stroke-width: 1.5; fill: none; marker-end: url(#arrowhead); }
  .graph-tooltip { position: absolute; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; font-size: 12px; pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.08); z-index: 10; max-width: 300px; }
  .graph-tooltip .tt-title { font-weight: 600; margin-bottom: 4px; }
  .graph-tooltip .tt-row { color: var(--dim); }
  .graph-legend { position: absolute; bottom: 12px; left: 12px; display: flex; gap: 14px; font-size: 11px; color: var(--dim); background: var(--bg); padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); }
  .graph-legend span::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .legend-agent::before { background: var(--accent); }
  .legend-llm::before { background: var(--yellow); }
  .legend-tool::before { background: var(--green); }

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

  /* Collapsible groups */
  .tree-group-header { cursor: pointer; user-select: none; }
  .tree-group-header:hover { background: var(--surface2); border-radius: 3px; }
  .tree-group-toggle { display: inline-block; width: 14px; text-align: center; font-size: 10px; color: var(--dim); margin-right: 2px; transition: transform 0.15s; }
  .tree-group-toggle.open { transform: rotate(90deg); }
  .tree-group-badge { background: var(--surface2); color: var(--dim); border: 1px solid var(--border); border-radius: 10px; padding: 0 6px; font-size: 11px; margin-left: 6px; }
  .tree-group-body { display: none; }
  .tree-group-body.open { display: block; }
  .tree-group-summary { color: var(--dim); font-size: 12px; margin-left: 4px; }

  /* Work Index */
  .wi-container { display: flex; flex-direction: column; gap: 16px; }
  .wi-chart { position: relative; width: 100%; height: 200px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
  .wi-chart svg { width: 100%; height: 100%; }
  .wi-score-card { display: flex; gap: 16px; flex-wrap: wrap; }
  .wi-card { flex: 1; min-width: 160px; padding: 14px 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  .wi-card .wi-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .wi-card .wi-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .wi-card .wi-sub { font-size: 11px; color: var(--dim); margin-top: 2px; }
  .wi-phases { width: 100%; border-collapse: collapse; }
  .wi-phases th { text-align: left; padding: 6px 10px; border-bottom: 2px solid var(--border); font-size: 11px; color: var(--dim); text-transform: uppercase; }
  .wi-phases td { padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .wi-phases tr:hover { background: var(--surface); }
  .wi-bar-cell { width: 120px; }
  .wi-bar-bg { width: 100px; height: 14px; background: var(--surface2); border-radius: 7px; display: inline-block; vertical-align: middle; overflow: hidden; }
  .wi-bar-fill { height: 100%; border-radius: 7px; }
  .wi-status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .wi-status-high { background: #dcfce7; color: #166534; }
  .wi-status-mid { background: #fef9c3; color: #854d0e; }
  .wi-status-low { background: #fee2e2; color: #991b1b; }
  .wi-status-idle { background: var(--surface2); color: var(--dim); }
</style>
</head>
<body>
<div class="header">
  <h1>🦞 OpenClaw Traces</h1>
  <select id="dateSelect"><option>Loading...</option></select>
  <span id="spanCount" class="dim"></span>
  <label style="margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--dim)">
    <input type="checkbox" id="autoRefresh" checked> Auto-refresh (3s)
    <span id="liveIndicator" style="width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block;animation:pulse 1.5s infinite"></span>
  </label>
  <style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}</style>
</div>
<div class="tabs">
  <div class="tab active" data-view="call">📊 Call Tree</div>
  <div class="tab" data-view="entity">🕸️ Entity Graph</div>
  <div class="tab" data-view="waterfall">⏱️ Waterfall</div>
  <div class="tab" data-view="workindex">📈 Work Index</div>
</div>
<div class="content" id="content"></div>

<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let spans = [];
let currentView = 'call';
let knownSpanIds = new Set();
let newSpanIds = new Set();

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

async function load(date, isRefresh) {
  spans = await fetchSpans(date);
  if (isRefresh && knownSpanIds.size > 0) {
    newSpanIds = new Set();
    for (const s of spans) {
      if (!knownSpanIds.has(s.spanId)) newSpanIds.add(s.spanId);
    }
  } else {
    newSpanIds = new Set();
  }
  knownSpanIds = new Set(spans.map(s => s.spanId));
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
  else if (currentView === 'waterfall') c.innerHTML = renderWaterfall();
  else if (currentView === 'workindex') c.innerHTML = renderWorkIndex();
}

// Utils
function fmtDur(ms) {
  if (ms == null) return '';
  return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

const icons = { session: '🔵', llm_call: '🧠', tool_call: '🔧', subagent: '🤖' };

function toggleGroup(id, header) {
  const body = document.getElementById(id);
  const tog = document.getElementById(id + '-tog');
  if (!body) return;
  const isOpen = body.classList.toggle('open');
  if (tog) { tog.classList.toggle('open', isOpen); tog.textContent = '▶'; }
}

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
  let groupId = 0;

  function spanLabel(span) {
    if (span.kind === 'session') {
      return '<span class="kind-session">' + esc(span.agentId || 'agent') + '</span> <span class="dim">(' + esc(span.sessionKey || '') + ')</span>';
    } else if (span.kind === 'llm_call') {
      return '<span class="kind-llm_call">llm</span> <span class="dim">[' + esc(span.provider||'') + '/' + esc(span.model||'') + ']</span>';
    } else if (span.kind === 'tool_call') {
      let l = '<span class="kind-tool_call">' + esc(span.toolName || span.name) + '</span>';
      if (span.toolParams) {
        const preview = Object.entries(span.toolParams).map(([k,v]) => {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return k + '=' + (s.length > 30 ? s.slice(0,30) + '…' : s);
        }).join(', ');
        l += '<span class="tool-params">(' + esc(preview) + ')</span>';
      }
      return l;
    } else if (span.kind === 'subagent') {
      return '<span class="kind-subagent">→ ' + esc(span.childAgentId||'') + '</span> <span class="dim">(' + esc(span.childSessionKey||'') + ')</span>';
    }
    return esc(span.name || '');
  }

  function spanDurTok(span) {
    let s = '';
    if (span.durationMs != null) s += '<span class="duration">' + fmtDur(span.durationMs) + '</span>';
    if (span.kind === 'llm_call' && (span.tokensIn || span.tokensOut)) {
      s += '<span class="tokens">[in:' + (span.tokensIn||0) + ' out:' + (span.tokensOut||0) + ']</span>';
    }
    return s;
  }

  // Group consecutive children that share same kind+toolName (for tool_call) or kind (for llm_call)
  function groupKey(span) {
    if (span.kind === 'tool_call') return 'tool:' + (span.toolName || span.name);
    if (span.kind === 'llm_call') return 'llm:' + (span.model || '');
    return null; // don't group session/subagent
  }

  function groupChildren(kids) {
    const groups = [];
    let i = 0;
    while (i < kids.length) {
      const gk = groupKey(kids[i]);
      if (gk && i + 1 < kids.length && groupKey(kids[i+1]) === gk) {
        // Start a group of consecutive same-key spans
        const group = [kids[i]];
        let j = i + 1;
        while (j < kids.length && groupKey(kids[j]) === gk) { group.push(kids[j]); j++; }
        groups.push(group);
        i = j;
      } else {
        groups.push([kids[i]]);
        i++;
      }
    }
    return groups;
  }

  function renderNode(span, prefix, isLast) {
    const conn = isLast ? '└─ ' : '├─ ';
    const icon = icons[span.kind] || '●';
    const cls = 'tree-node' + (newSpanIds.has(span.spanId) ? ' new-span' : '');
    html += '<div class="' + cls + '"><span class="tree-indent">' + esc(prefix) + '</span><span class="tree-connector">' + conn + '</span>' + icon + ' ' + spanLabel(span) + spanDurTok(span) + '</div>';
    const kids = dedupedChildren.get(span.spanId) || [];
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    renderChildren(kids, childPrefix);
  }

  function renderChildren(kids, prefix) {
    if (!kids.length) return;
    const groups = groupChildren(kids);
    groups.forEach((group, gi) => {
      const isLast = gi === groups.length - 1;
      if (group.length === 1) {
        renderNode(group[0], prefix, isLast);
      } else {
        // Collapsed group
        const gid = 'tg-' + (groupId++);
        const first = group[0];
        const icon = icons[first.kind] || '●';
        const toolName = first.kind === 'tool_call' ? (first.toolName || first.name) : (first.kind === 'llm_call' ? 'llm' : first.name);
        const conn = isLast ? '└─ ' : '├─ ';
        const totalDur = group.reduce((s, x) => s + (x.durationMs || 0), 0);
        const durStr = totalDur ? '<span class="duration">' + fmtDur(totalDur) + '</span>' : '';
        // Summary for llm groups: total tokens
        let summaryStr = '';
        if (first.kind === 'llm_call') {
          const tIn = group.reduce((s, x) => s + (x.tokensIn||0), 0);
          const tOut = group.reduce((s, x) => s + (x.tokensOut||0), 0);
          if (tIn || tOut) summaryStr = '<span class="tokens">[in:' + tIn + ' out:' + tOut + ']</span>';
        }
        const kindClass = 'kind-' + first.kind;
        html += '<div class="tree-node tree-group-header" onclick="toggleGroup(' + "'" + gid + "'" + ',this)">'
          + '<span class="tree-indent">' + esc(prefix) + '</span><span class="tree-connector">' + conn + '</span>'
          + '<span class="tree-group-toggle" id="' + gid + '-tog">▶</span>'
          + icon + ' <span class="' + kindClass + '">' + esc(toolName) + '</span>'
          + '<span class="tree-group-badge">×' + group.length + '</span>'
          + durStr + summaryStr
          + '</div>';
        html += '<div class="tree-group-body" id="' + gid + '">';
        const innerPrefix = prefix + (isLast ? '   ' : '│  ');
        group.forEach((span, si) => {
          renderNode(span, innerPrefix, si === group.length - 1);
        });
        html += '</div>';
      }
    });
  }

  roots.forEach((r, i) => renderNode(r, '', i === roots.length - 1));
  return html;
}

// Entity Graph — force-directed SVG, using sessionKey to distinguish subagents
function renderEntityTree() {
  // Dedupe
  const closed = new Map();
  for (const s of spans) {
    if (!closed.has(s.spanId) || s.endMs != null) closed.set(s.spanId, s);
  }
  const deduped = [...closed.values()];

  // Build agent entities by sessionKey (each subagent is its own entity)
  const entities = new Map();
  for (const s of deduped) {
    const sk = s.sessionKey;
    if (!sk) continue;
    if (!entities.has(sk)) {
      // Derive a short label
      let label = s.agentId || 'agent';
      if (sk.includes(':subagent:')) {
        // Try to find the sessions_spawn tool call that has a label param
        const uuid = sk.split(':subagent:')[1];
        const spawnCall = deduped.find(x => x.toolName === 'sessions_spawn' && x.toolParams && JSON.stringify(x.toolParams).includes(uuid));
        if (spawnCall && spawnCall.toolParams && spawnCall.toolParams.label) {
          label = spawnCall.toolParams.label;
        } else {
          label = 'subagent:' + (uuid || '').slice(0, 8);
        }
      }
      entities.set(sk, { id: sk, label, type: 'agent', tools: new Set(), models: new Set(), llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, durationMs: 0, parentSessionSpanId: null });
    }
    const a = entities.get(sk);
    if (s.kind === 'session') { a.durationMs = s.durationMs || 0; a.parentSessionSpanId = s.parentSpanId || null; }
    if (s.kind === 'llm_call') { a.llmCalls++; a.tokensIn += s.tokensIn||0; a.tokensOut += s.tokensOut||0; if (s.model) a.models.add(s.model); }
    if (s.kind === 'tool_call' && s.toolName !== 'sessions_spawn') { a.toolCalls++; if (s.toolName) a.tools.add(s.toolName); }
  }

  // Find parent-child relationships between entities via session parentSpanId
  const sessionSpanToKey = new Map();
  for (const s of deduped) {
    if (s.kind === 'session') sessionSpanToKey.set(s.spanId, s.sessionKey);
  }

  const nodes = [];
  const links = [];
  const nodeIdx = new Map();

  // Agent/subagent nodes
  for (const [sk, a] of entities) {
    nodeIdx.set('entity:'+sk, nodes.length);
    const isMain = !sk.includes(':subagent:');
    nodes.push({ id: sk, type: 'agent', label: a.label, r: isMain ? 34 : 26, data: a, isMain });
  }

  // Per-entity tool nodes (scoped: each entity gets its own tool nodes)
  for (const [sk, a] of entities) {
    for (const t of a.tools) {
      const toolKey = sk + '::tool:' + t;
      nodeIdx.set(toolKey, nodes.length);
      nodes.push({ id: toolKey, type: 'tool', label: t, r: 12 });
      // Link entity → tool
      const si = nodeIdx.get('entity:'+sk);
      links.push({ source: si, target: nodes.length - 1, type: 'uses-tool' });
    }
  }

  // Model nodes (shared across entities)
  const allModels = new Set();
  for (const a of entities.values()) for (const m of a.models) allModels.add(m);
  for (const m of allModels) {
    nodeIdx.set('model:'+m, nodes.length);
    nodes.push({ id: m, type: 'model', label: m.split('/').pop().replace(/-/g,' '), r: 18 });
  }
  // Link entities → models
  for (const [sk, a] of entities) {
    for (const m of a.models) {
      const si = nodeIdx.get('entity:'+sk), ti = nodeIdx.get('model:'+m);
      if (si != null && ti != null) links.push({ source: si, target: ti, type: 'uses-model' });
    }
  }

  // Parent → child (subagent spawns) links
  for (const [sk, a] of entities) {
    if (a.parentSessionSpanId) {
      const parentSk = sessionSpanToKey.get(a.parentSessionSpanId);
      if (parentSk) {
        const si = nodeIdx.get('entity:'+parentSk), ti = nodeIdx.get('entity:'+sk);
        if (si != null && ti != null) links.push({ source: si, target: ti, type: 'spawns' });
      }
    }
  }

  if (!nodes.length) return '<div class="empty">No entities to graph.</div>';

  // Summary stats
  const totalLlm = deduped.filter(s => s.kind === 'llm_call').length;
  const totalTools2 = deduped.filter(s => s.kind === 'tool_call').length;
  const totalTokens = deduped.reduce((sum, s) => sum + (s.tokensIn||0) + (s.tokensOut||0), 0);

  // Return container; simulation runs after insert
  const graphId = 'graph-' + Date.now();
  setTimeout(() => initGraph(graphId, nodes, links), 0);

  return '<div class="graph-container" id="' + graphId + '"></div>'
    + '<div class="summary">Entities: <strong>' + entities.size + '</strong> &nbsp; Models: <strong>' + allModels.size + '</strong> &nbsp; LLM calls: <strong>' + totalLlm + '</strong> &nbsp; Tool calls: <strong>' + totalTools2 + '</strong> &nbsp; Total tokens: <strong>' + totalTokens + '</strong></div>';
}

function initGraph(containerId, nodes, links) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const W = container.clientWidth, H = container.clientHeight;
  const colors = { agent: '#2563eb', model: '#ca8a04', tool: '#16a34a' };
  const bgColors = { agent: '#eff6ff', model: '#fefce8', tool: '#f0fdf4' };

  // Init positions: spread agents in center, others around
  const cx = W / 2, cy = H / 2;
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const dist = n.type === 'agent' ? 80 : 180 + Math.random() * 60;
    n.x = cx + Math.cos(angle) * dist;
    n.y = cy + Math.sin(angle) * dist;
    n.vx = 0; n.vy = 0;
  });

  // SVG
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

  // Arrow marker
  const defs = document.createElementNS(ns, 'defs');
  const marker = document.createElementNS(ns, 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('viewBox', '0 0 10 7');
  marker.setAttribute('refX', '10'); marker.setAttribute('refY', '3.5');
  marker.setAttribute('markerWidth', '8'); marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto');
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M 0 0 L 10 3.5 L 0 7 z');
  arrow.setAttribute('fill', '#9ca3af');
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Link elements
  const linkEls = links.map(l => {
    const line = document.createElementNS(ns, 'line');
    line.classList.add('graph-link');
    if (l.type === 'spawns') { line.style.stroke = '#2563eb'; line.style.strokeWidth = '2'; line.style.strokeDasharray = '6,3'; }
    svg.appendChild(line);
    return line;
  });

  // Node groups
  const nodeEls = nodes.map((n, i) => {
    const g = document.createElementNS(ns, 'g');
    g.classList.add('graph-node');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('r', '' + n.r);
    circle.setAttribute('fill', bgColors[n.type] || '#fff');
    circle.setAttribute('stroke', colors[n.type] || '#999');
    g.appendChild(circle);

    const icon = document.createElementNS(ns, 'text');
    icon.setAttribute('text-anchor', 'middle');
    icon.setAttribute('dy', n.type === 'agent' ? '-4' : '1');
    icon.setAttribute('font-size', n.type === 'agent' ? '16' : '12');
    icon.textContent = n.type === 'agent' ? '🤖' : n.type === 'model' ? '🧠' : '🔧';
    g.appendChild(icon);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dy', n.type === 'agent' ? '12' : '24');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', colors[n.type]);
    const labelText = n.label.length > 20 ? n.label.slice(0, 18) + '…' : n.label;
    label.textContent = labelText;
    g.appendChild(label);

    if (n.type === 'agent' && n.data) {
      const stats = document.createElementNS(ns, 'text');
      stats.classList.add('node-stats');
      stats.setAttribute('text-anchor', 'middle');
      stats.setAttribute('dy', '23');
      stats.textContent = n.data.llmCalls + ' llm / ' + n.data.toolCalls + ' tools';
      g.appendChild(stats);
    }

    // Drag
    let dragging = false, dragOffX = 0, dragOffY = 0;
    g.addEventListener('mousedown', (e) => { dragging = true; dragOffX = e.clientX - n.x; dragOffY = e.clientY - n.y; n.fixed = true; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!dragging) return; const rect = svg.getBoundingClientRect(); const scaleX = W / rect.width; const scaleY = H / rect.height; n.x = (e.clientX - rect.left) * scaleX; n.y = (e.clientY - rect.top) * scaleY; n.vx = 0; n.vy = 0; });
    document.addEventListener('mouseup', () => { if (dragging) { dragging = false; n.fixed = false; } });

    // Tooltip
    g.addEventListener('mouseenter', (e) => {
      let tip = document.getElementById('graph-tooltip');
      if (!tip) { tip = document.createElement('div'); tip.id = 'graph-tooltip'; tip.classList.add('graph-tooltip'); container.appendChild(tip); }
      let html = '<div class="tt-title">' + esc(n.label) + '</div>';
      if (n.data) {
        html += '<div class="tt-row">LLM calls: ' + n.data.llmCalls + '</div>';
        html += '<div class="tt-row">Tool calls: ' + n.data.toolCalls + '</div>';
        html += '<div class="tt-row">Tokens: ' + n.data.tokensIn + ' → ' + n.data.tokensOut + '</div>';
        if (n.data.models.size) html += '<div class="tt-row">Models: ' + [...n.data.models].join(', ') + '</div>';
        if (n.data.tools.size) html += '<div class="tt-row">Tools: ' + [...n.data.tools].join(', ') + '</div>';
        if (n.data.durationMs) html += '<div class="tt-row">Duration: ' + fmtDur(n.data.durationMs) + '</div>';
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
    });
    g.addEventListener('mouseleave', () => { const tip = document.getElementById('graph-tooltip'); if (tip) tip.style.display = 'none'; });
    g.addEventListener('mousemove', (e) => {
      const tip = document.getElementById('graph-tooltip');
      if (tip) { const rect = container.getBoundingClientRect(); tip.style.left = (e.clientX - rect.left + 14) + 'px'; tip.style.top = (e.clientY - rect.top + 14) + 'px'; }
    });

    svg.appendChild(g);
    return g;
  });

  // Legend
  const legend = document.createElement('div');
  legend.className = 'graph-legend';
  legend.innerHTML = '<span class="legend-agent">Agent</span><span class="legend-llm">Model</span><span class="legend-tool">Tool</span>';
  container.appendChild(svg);
  container.appendChild(legend);

  // Force simulation
  const alpha = { value: 1 };
  function tick() {
    if (alpha.value < 0.001) return;
    alpha.value *= 0.98;

    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = a.r + b.r + 40;
        const force = 800 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
        if (!b.fixed) { b.vx += fx; b.vy += fy; }
        // Overlap push
        if (dist < minDist) {
          const push = (minDist - dist) * 0.3;
          const px = (dx / dist) * push, py = (dy / dist) * push;
          if (!a.fixed) { a.x -= px; a.y -= py; }
          if (!b.fixed) { b.x += px; b.y += py; }
        }
      }
    }

    // Link attraction
    for (const l of links) {
      const a = nodes[l.source], b = nodes[l.target];
      let dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetDist = a.r + b.r + 80;
      const force = (dist - targetDist) * 0.01;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }

    // Center gravity
    for (const n of nodes) {
      if (n.fixed) continue;
      n.vx += (cx - n.x) * 0.002;
      n.vy += (cy - n.y) * 0.002;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
      // Keep in bounds
      n.x = Math.max(n.r + 5, Math.min(W - n.r - 5, n.x));
      n.y = Math.max(n.r + 5, Math.min(H - n.r - 5, n.y));
    }

    // Update SVG
    links.forEach((l, i) => {
      const a = nodes[l.source], b = nodes[l.target];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx*dx + dy*dy) || 1;
      const offsetX = (dx/dist) * b.r, offsetY = (dy/dist) * b.r;
      linkEls[i].setAttribute('x1', '' + a.x); linkEls[i].setAttribute('y1', '' + a.y);
      linkEls[i].setAttribute('x2', '' + (b.x - offsetX)); linkEls[i].setAttribute('y2', '' + (b.y - offsetY));
    });
    nodes.forEach((n, i) => {
      nodeEls[i].setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
    });

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
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

// Work Index
function renderWorkIndex() {
  // Dedupe
  const closed = new Map();
  for (const s of spans) {
    if (!closed.has(s.spanId) || s.endMs != null) closed.set(s.spanId, s);
  }
  const deduped = [...closed.values()];
  if (!deduped.length) return '<div class="empty">No spans to analyze.</div>';

  const minStart = Math.min(...deduped.map(s => s.startMs));
  const maxEnd = Math.max(...deduped.map(s => s.endMs || s.startMs));
  const totalDuration = maxEnd - minStart || 1;

  // Slice into time windows (each ~10% of total or at least 5s)
  const windowSize = Math.max(5000, totalDuration / 12);
  const windows = [];
  for (let t = minStart; t < maxEnd; t += windowSize) {
    const wEnd = Math.min(t + windowSize, maxEnd);
    const wSpans = deduped.filter(s => s.startMs < wEnd && (s.endMs || s.startMs) > t);
    const llmCalls = wSpans.filter(s => s.kind === 'llm_call').length;
    const toolCalls = wSpans.filter(s => s.kind === 'tool_call').length;
    const tokensUsed = wSpans.reduce((sum, s) => sum + (s.tokensIn || 0) + (s.tokensOut || 0), 0);
    const subagents = wSpans.filter(s => s.kind === 'subagent').length;

    // Work Index formula:
    // tool_density = toolCalls / max(llmCalls, 1)
    // token_efficiency = toolCalls / max(tokensUsed / 1000, 0.1)
    // bonus for subagent spawns (delegation = productive)
    // penalty for consecutive empty LLM calls
    const toolDensity = toolCalls / Math.max(llmCalls, 1);
    const tokenEff = toolCalls / Math.max(tokensUsed / 1000, 0.1);

    let score;
    if (llmCalls === 0 && toolCalls === 0) {
      score = 0; // idle
    } else {
      // Normalize: toolDensity usually 0-5, tokenEff usually 0-3
      // Score 0-100
      score = Math.min(100, Math.round(
        (Math.min(toolDensity, 5) / 5) * 50 +
        (Math.min(tokenEff, 3) / 3) * 30 +
        (subagents > 0 ? 20 : 0)
      ));
      // If lots of tokens but no tools, cap low
      if (llmCalls > 0 && toolCalls === 0) score = Math.min(score, 15);
    }

    let status, statusClass;
    if (score === 0) { status = 'Idle'; statusClass = 'idle'; }
    else if (score <= 25) { status = 'Spinning'; statusClass = 'low'; }
    else if (score <= 60) { status = 'Planning'; statusClass = 'mid'; }
    else { status = 'Working'; statusClass = 'high'; }

    windows.push({
      startMs: t, endMs: wEnd, llmCalls, toolCalls, tokensUsed, subagents,
      toolDensity, tokenEff, score, status, statusClass
    });
  }

  // Overall stats
  const totalLlm = deduped.filter(s => s.kind === 'llm_call').length;
  const totalTools = deduped.filter(s => s.kind === 'tool_call').length;
  const totalTokens = deduped.reduce((sum, s) => sum + (s.tokensIn || 0) + (s.tokensOut || 0), 0);
  const totalSubagents = deduped.filter(s => s.kind === 'subagent').length;
  const avgScore = windows.length ? Math.round(windows.reduce((s, w) => s + w.score, 0) / windows.length) : 0;
  const overallDensity = (totalTools / Math.max(totalLlm, 1)).toFixed(2);
  const overallEff = (totalTools / Math.max(totalTokens / 1000, 0.1)).toFixed(2);

  // Score color
  function scoreColor(s) {
    if (s === 0) return '#9ca3af';
    if (s <= 25) return '#dc2626';
    if (s <= 60) return '#ca8a04';
    return '#16a34a';
  }

  // Build chart SVG - area chart of work index over time
  const chartW = 800, chartH = 180, pad = 40;
  const plotW = chartW - pad * 2, plotH = chartH - pad * 1.5;
  let pathD = 'M ' + pad + ' ' + (pad + plotH);
  const points = [];
  windows.forEach((w, i) => {
    const x = pad + (i / Math.max(windows.length - 1, 1)) * plotW;
    const y = pad + plotH - (w.score / 100) * plotH;
    points.push({ x, y, w });
    if (i === 0) pathD += ' L ' + x + ' ' + y;
    else pathD += ' L ' + x + ' ' + y;
  });
  pathD += ' L ' + (pad + plotW) + ' ' + (pad + plotH) + ' Z';

  // Gradient stops based on scores
  let gradStops = '';
  windows.forEach((w, i) => {
    const pct = (i / Math.max(windows.length - 1, 1) * 100).toFixed(1);
    gradStops += '<stop offset="' + pct + '%" stop-color="' + scoreColor(w.score) + '" stop-opacity="0.3"/>';
  });

  let svg = '<svg viewBox="0 0 ' + chartW + ' ' + chartH + '">';
  svg += '<defs><linearGradient id="wiGrad" x1="0" y1="0" x2="1" y2="0">' + gradStops + '</linearGradient></defs>';

  // Grid lines
  for (let v = 0; v <= 100; v += 25) {
    const y = pad + plotH - (v / 100) * plotH;
    svg += '<line x1="' + pad + '" y1="' + y + '" x2="' + (pad + plotW) + '" y2="' + y + '" stroke="#e5e7eb" stroke-dasharray="3,3"/>';
    svg += '<text x="' + (pad - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#9ca3af">' + v + '</text>';
  }

  // Area
  svg += '<path d="' + pathD + '" fill="url(#wiGrad)"/>';

  // Line
  let lineD = '';
  points.forEach((p, i) => { lineD += (i === 0 ? 'M' : 'L') + ' ' + p.x + ' ' + p.y; });
  svg += '<path d="' + lineD + '" fill="none" stroke="#2563eb" stroke-width="2"/>';

  // Dots
  points.forEach(p => {
    svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="' + scoreColor(p.w.score) + '" stroke="#fff" stroke-width="1.5"/>';
  });

  // X axis labels (time offsets)
  windows.forEach((w, i) => {
    if (i % Math.max(1, Math.floor(windows.length / 6)) !== 0 && i !== windows.length - 1) return;
    const x = pad + (i / Math.max(windows.length - 1, 1)) * plotW;
    const t = fmtDur(w.startMs - minStart);
    svg += '<text x="' + x + '" y="' + (chartH - 5) + '" text-anchor="middle" font-size="10" fill="#9ca3af">' + t + '</text>';
  });

  svg += '<text x="' + (chartW / 2) + '" y="14" text-anchor="middle" font-size="12" fill="#6b7280" font-weight="600">Work Index over Time</text>';
  svg += '</svg>';

  // Build HTML
  let h = '<div class="wi-container">';

  // Score cards
  h += '<div class="wi-score-card">';
  h += '<div class="wi-card"><div class="wi-label">Overall Work Index</div><div class="wi-value" style="color:' + scoreColor(avgScore) + '">' + avgScore + '</div><div class="wi-sub">out of 100</div></div>';
  h += '<div class="wi-card"><div class="wi-label">Tool Density</div><div class="wi-value">' + overallDensity + '</div><div class="wi-sub">tools per LLM call</div></div>';
  h += '<div class="wi-card"><div class="wi-label">Token Efficiency</div><div class="wi-value">' + overallEff + '</div><div class="wi-sub">tools per 1k tokens</div></div>';
  h += '<div class="wi-card"><div class="wi-label">Delegation</div><div class="wi-value">' + totalSubagents + '</div><div class="wi-sub">subagents spawned</div></div>';
  h += '</div>';

  // Chart
  h += '<div class="wi-chart">' + svg + '</div>';

  // Phase table
  h += '<table class="wi-phases">';
  h += '<tr><th>Phase</th><th>Score</th><th>Status</th><th>LLM</th><th>Tools</th><th>Tokens</th><th>Density</th><th></th></tr>';
  windows.forEach((w, i) => {
    const timeLabel = fmtDur(w.startMs - minStart) + ' – ' + fmtDur(w.endMs - minStart);
    h += '<tr>';
    h += '<td>' + timeLabel + '</td>';
    h += '<td style="font-weight:700;color:' + scoreColor(w.score) + '">' + w.score + '</td>';
    h += '<td><span class="wi-status wi-status-' + w.statusClass + '">' + w.status + '</span></td>';
    h += '<td>' + w.llmCalls + '</td>';
    h += '<td>' + w.toolCalls + '</td>';
    h += '<td>' + w.tokensUsed.toLocaleString() + '</td>';
    h += '<td>' + w.toolDensity.toFixed(1) + '</td>';
    h += '<td class="wi-bar-cell"><div class="wi-bar-bg"><div class="wi-bar-fill" style="width:' + w.score + '%;background:' + scoreColor(w.score) + '"></div></div></td>';
    h += '</tr>';
  });
  h += '</table>';

  // Legend
  h += '<div class="summary">';
  h += '<strong>Work Index</strong> measures agent productivity per time window. ';
  h += '<span class="wi-status wi-status-high">Working</span> = high tool usage, ';
  h += '<span class="wi-status wi-status-mid">Planning</span> = moderate activity, ';
  h += '<span class="wi-status wi-status-low">Spinning</span> = high tokens but few tools, ';
  h += '<span class="wi-status wi-status-idle">Idle</span> = no activity';
  h += '</div>';

  h += '</div>';
  return h;
}

// Auto-refresh polling
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const sel = $('#dateSelect');
    if (!sel.value || sel.value === 'No traces') {
      const dates = await fetchDates();
      if (dates.length) {
        sel.innerHTML = dates.map(d => '<option value="'+d+'">'+d+'</option>').join('');
        load(dates[0]);
      }
      return;
    }
    const newSpans = await fetchSpans(sel.value);
    if (newSpans.length !== spans.length) {
      load(sel.value, true);
    }
  }, 3000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
$('#autoRefresh').onchange = (e) => {
  const indicator = $('#liveIndicator');
  if (e.target.checked) { startPolling(); indicator.style.background = '#16a34a'; }
  else { stopPolling(); indicator.style.background = '#9ca3af'; }
};
startPolling();
</script>
</body>
</html>`;
