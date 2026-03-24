#!/usr/bin/env bun
/**
 * Auto-Improve Dashboard Generator
 *
 * Reads all data sources (scores, diagnostics, fixes, GitHub) and generates
 * a self-contained HTML dashboard with tabs.
 *
 * Usage:
 *   bun .claude/skills/auto-improve/scripts/dashboard.ts
 *   open .claude/skills/auto-improve/dashboard.html
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(join(homedir(), "dev/operator1"));
const RESULTS_TSV = join(ROOT, ".claude/skills/auto-improve/data/results.tsv");
const FIXES_TSV = join(ROOT, ".claude/skills/auto-fix/data/fixes.tsv");
const SCORE_SCRIPT = join(ROOT, ".claude/skills/auto-improve/scripts/score.ts");
const OUTPUT_HTML = join(ROOT, ".claude/skills/auto-improve/dashboard.html");

function loadTsv(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cols[i] || ""));
    return row;
  });
}

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 20000, cwd: ROOT });
  } catch {
    return "[]";
  }
}

const results = loadTsv(RESULTS_TSV);
const fixes = loadTsv(FIXES_TSV);
const scores = JSON.parse(run(`bun ${SCORE_SCRIPT} --json`));
const diags = JSON.parse(run(`bun ${SCORE_SCRIPT} --diagnostics`));
const ghIssues = JSON.parse(
  run(
    "gh issue list --repo Interstellar-code/operator1 --state all --limit 50 --json number,title,state,labels,createdAt,closedAt,url",
  ),
);
const ghPRs = JSON.parse(
  run(
    "gh pr list --repo Interstellar-code/operator1 --state all --limit 50 --json number,title,state,labels,createdAt,mergedAt,closedAt,url,additions,deletions",
  ),
);
const generated = new Date().toLocaleString();

const main = scores.find((s: Record<string, unknown>) => s.agent === "main");
const fmt = (v: number) => (v >= 0 ? v.toFixed(3) : "-");
const prevScore = results.length > 0 ? parseFloat(results[results.length - 1].score) : null;
const scoreDiff = main && prevScore !== null ? main.composite - prevScore : 0;
const diffClass = scoreDiff > 0.01 ? "up" : scoreDiff < -0.01 ? "down" : "flat";
const diffText = scoreDiff >= 0 ? `+${scoreDiff.toFixed(3)}` : scoreDiff.toFixed(3);
const autoIssues = ghIssues.filter(
  (i: Record<string, unknown>) =>
    Array.isArray(i.labels) &&
    (i.labels as Record<string, string>[]).some((l) => l.name === "auto-improve"),
);
const autoPRs = ghPRs.filter(
  (p: Record<string, unknown>) =>
    String(p.title || "").startsWith("auto-fix:") ||
    String(p.title || "").startsWith("auto-improve:") ||
    (Array.isArray(p.labels) &&
      (p.labels as Record<string, string>[]).some((l) => l.name === "auto-improve")),
);
const autoOpenIssues = autoIssues.filter((i: Record<string, string>) => i.state === "OPEN");
const autoClosedIssues = autoIssues.filter((i: Record<string, string>) => i.state === "CLOSED");
const autoOpenPRs = autoPRs.filter((p: Record<string, string>) => p.state === "OPEN");
const autoMergedPRs = autoPRs.filter((p: Record<string, string>) => p.state === "MERGED");
const fixesVerified = fixes.filter((f) => f.status === "verified").length;
const fixesFailed = fixes.filter((f) => f.status === "failed").length;
const fixesPending = fixes.filter((f) => f.status === "pr-open" || f.status === "merged").length;

// Prepare per-agent trend data from results.tsv
const agentTrendData = JSON.stringify(
  results.map((r) => ({
    score: parseFloat(r.score) || 0,
    delegation: parseFloat(r.delegation) || 0,
    memory: parseFloat(r.memory) || 0,
    conciseness: parseFloat(r.conciseness) || 0,
    silent_reply: parseFloat(r.silent_reply) || 0,
    error_rate: parseFloat(r.error_rate) || 0,
    neo_exec: r.neo_exec === "-" ? null : parseFloat(r.neo_exec) || 0,
    morpheus_exec: r.morpheus_exec === "-" ? null : parseFloat(r.morpheus_exec) || 0,
    trinity_exec: r.trinity_exec === "-" ? null : parseFloat(r.trinity_exec) || 0,
    op1_wb: r.op1_wb === "-" ? null : parseFloat(r.op1_wb) || 0,
    neo_wb: r.neo_wb === "-" ? null : parseFloat(r.neo_wb) || 0,
    morpheus_wb: r.morpheus_wb === "-" ? null : parseFloat(r.morpheus_wb) || 0,
    trinity_wb: r.trinity_wb === "-" ? null : parseFloat(r.trinity_wb) || 0,
  })),
);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Operator1 Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px}
h1{color:#58a6ff;font-size:24px;margin-bottom:4px}
.sub{color:#8b949e;font-size:13px;margin-bottom:16px}
.tabs{display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid #30363d}
.tab{padding:10px 20px;cursor:pointer;color:#8b949e;font-size:14px;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s;user-select:none}
.tab:hover{color:#c9d1d9}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.cnt{display:inline-block;background:#30363d;color:#c9d1d9;font-size:11px;padding:1px 6px;border-radius:10px;margin-left:6px}
.tc{display:none}.tc.active{display:block}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px}
.card h2{color:#58a6ff;font-size:16px;margin-bottom:12px}
.card h3{color:#8b949e;font-size:13px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
.mv{font-size:36px;font-weight:700;color:#f0f6fc;line-height:1}
.ml{color:#8b949e;font-size:12px;margin-top:4px}
.mc{font-size:14px;margin-left:8px}
.mc.up{color:#3fb950}.mc.down{color:#f85149}.mc.flat{color:#8b949e}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;border-bottom:2px solid #30363d;color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:#58a6ff}
th .sort-arrow{font-size:10px;margin-left:4px;color:#484f58}
th.sorted .sort-arrow{color:#58a6ff}
td{padding:8px 12px;border-bottom:1px solid #21262d}
tr:hover td{background:#1c2128}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.b{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.b-keep,.b-MERGED,.b-verified,.b-CLOSED{background:#0d2818;color:#3fb950}
.b-discard,.b-failed{background:#2d1115;color:#f85149}
.b-baseline,.b-out-of-scope{background:#1c1d21;color:#8b949e}
.b-pending,.b-medium{background:#2a1f00;color:#d29922}
.b-high{background:#2d1115;color:#f85149}
.b-low{background:#0d2818;color:#3fb950}
.b-pr-open,.b-OPEN{background:#1c1d21;color:#58a6ff}
.b-merged{background:#0d2818;color:#3fb950}
.sg{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.si{text-align:center}
.si .v{font-size:20px;font-weight:700}
.si .l{font-size:11px;color:#8b949e;margin-top:2px}
.ag{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.ac{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px}
.ac h4{color:#f0f6fc;font-size:14px;margin-bottom:8px}
.mr{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}
.mr .l{color:#8b949e}
.ch{position:relative;height:280px}
.es{color:#484f58;text-align:center;padding:40px;font-style:italic}
.rn{text-align:center;color:#484f58;font-size:12px;margin-top:16px;padding:12px}
code{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:#21262d;padding:2px 6px;border-radius:4px}
.sr{display:flex;gap:16px;margin-bottom:20px}
.sc{flex:1;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;text-align:center}
.sc .num{font-size:28px;font-weight:700;color:#f0f6fc}
.sc .lbl{font-size:12px;color:#8b949e;margin-top:4px}
.scroll{max-height:500px;overflow-y:auto}
.filter-bar{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.filter-btn{padding:4px 12px;border-radius:14px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid #30363d;background:#0d1117;color:#8b949e;transition:all .2s}
.filter-btn:hover{border-color:#58a6ff;color:#c9d1d9}
.filter-btn.active{background:#1f6feb;border-color:#1f6feb;color:#fff}
.pipeline{display:flex;gap:8px;align-items:center;margin-bottom:20px;flex-wrap:wrap}
.pipe-step{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;text-align:center;flex:1;min-width:120px}
.pipe-step .num{font-size:24px;font-weight:700}
.pipe-step .lbl{font-size:11px;color:#8b949e;margin-top:2px}
.pipe-arrow{color:#30363d;font-size:20px}
.subtabs{display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid #21262d}
.subtab{padding:8px 16px;cursor:pointer;color:#8b949e;font-size:13px;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px}
.subtab:hover{color:#c9d1d9}
.subtab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.stc{display:none}.stc.active{display:block}
</style>
</head>
<body>

<h1>Operator1 Dashboard</h1>
<p class="sub">Generated: ${generated} &mdash; Refresh: <code>bun .claude/skills/auto-improve/scripts/dashboard.ts</code></p>

<div class="tabs">
  <div class="tab active" onclick="switchTab('metrics')">Agent Improvement</div>
  <div class="tab" onclick="switchTab('platform')">Platform Improvement<span class="cnt">${fixes.length + autoOpenIssues.length}</span></div>
  <div class="tab" onclick="switchTab('history')">History<span class="cnt">${results.length + fixes.length}</span></div>
</div>

<!-- ==================== AGENT IMPROVEMENT ==================== -->
<div id="tab-metrics" class="tc active">

<div class="grid">
  <div class="card" id="leftMetricsCard">
    <div id="leftMetricsContent">
      <h2>Composite Score</h2>
      <div class="mv">${main ? fmt(main.composite) : "-"}<span class="mc ${diffClass}">${prevScore !== null ? diffText : ""}</span></div>
      <div class="ml">Operator1 (main) &mdash; ${main?.sessions_analyzed || 0} sessions analyzed</div>
      <div style="margin-top:16px">
        <h3>Metric Breakdown</h3>
        <div class="sg">
          ${
            main
              ? [
                  { k: "delegation", l: "Delegation", w: "0.30" },
                  { k: "memory", l: "Memory", w: "0.20" },
                  { k: "conciseness", l: "Conciseness", w: "0.15" },
                  { k: "silent_reply", l: "Silent Reply", w: "0.15" },
                  { k: "error_rate", l: "Tool Errors", w: "0.20" },
                ]
                  .map((m) => {
                    const v = main[m.k] as number;
                    const c = v >= 0.8 ? "#3fb950" : v >= 0.5 ? "#d29922" : "#f85149";
                    return `<div class="si"><div class="v" style="color:${c}">${v >= 0 ? v.toFixed(2) : "-"}</div><div class="l">${m.l} (${m.w})</div></div>`;
                  })
                  .join("")
              : ""
          }
        </div>
      </div>
    </div>
  </div>
  <div class="card">
    <h2>Score Trend</h2>
    <div class="filter-bar">
      <button class="filter-btn active" onclick="setChartView('composite')">Composite</button>
      <button class="filter-btn" onclick="setChartView('op1')">Operator1</button>
      <button class="filter-btn" onclick="setChartView('neo')">Neo</button>
      <button class="filter-btn" onclick="setChartView('morpheus')">Morpheus</button>
      <button class="filter-btn" onclick="setChartView('trinity')">Trinity</button>
      <button class="filter-btn" onclick="setChartView('all')">All Agents</button>
    </div>
    <div class="ch"><canvas id="trendChart"></canvas></div>
  </div>
</div>

<div class="card" style="margin-bottom:20px">
  <h2>Agent Overview</h2>
  <div class="ag">
    ${scores
      .map((a: Record<string, unknown>) => {
        const name = a.agent === "main" ? "Operator1 (main)" : String(a.agent);
        return `<div class="ac"><h4>${name}</h4>
        <div class="mr"><span class="l">Sessions</span><span>${a.sessions_analyzed}</span></div>
        <div class="mr"><span class="l">Composite</span><span style="font-weight:700">${fmt(a.composite as number)}</span></div>
        <div class="mr"><span class="l">Exec Rate</span><span>${fmt(a.tool_exec_rate as number)}</span></div>
        <div class="mr"><span class="l">Write-Back</span><span>${fmt(a.memory_writeback as number)}</span></div>
        <div class="mr"><span class="l">Richness</span><span>${fmt(a.memory_richness as number)}</span></div>
        <div class="mr"><span class="l">Memory</span><span>${fmt(a.memory as number)}</span></div>
      </div>`;
      })
      .join("")}
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Platform Diagnostics</h2>
    ${
      diags.length === 0
        ? '<div class="es">No platform issues detected</div>'
        : `<table>
      <thead><tr><th>Category</th><th>Severity</th><th>Agent</th><th>Tool</th><th>Evidence</th></tr></thead>
      <tbody>${diags
        .map(
          (d: Record<string, string>) => `<tr>
        <td>${d.category}</td>
        <td><span class="b b-${d.severity}">${d.severity}</span></td>
        <td>${d.agent}</td>
        <td><code>${d.tool_name}</code></td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(d.evidence || "").replace(/"/g, "&quot;")}">${(d.evidence || "").slice(0, 80)}</td>
      </tr>`,
        )
        .join("")}</tbody></table>`
    }
  </div>
  <div class="card">
    <h2>Auto-Fix Attempts</h2>
    ${
      fixes.length === 0
        ? '<div class="es">No fix attempts yet</div>'
        : `<table>
      <thead><tr><th>#</th><th>Category</th><th>Sev</th><th>PR</th><th>Status</th><th>Description</th></tr></thead>
      <tbody>${fixes
        .map(
          (f: Record<string, string>) => `<tr>
        <td><a href="https://github.com/Interstellar-code/operator1/issues/${f.issue}">#${f.issue}</a></td>
        <td>${f.category}</td>
        <td><span class="b b-${f.severity}">${f.severity}</span></td>
        <td>${f.pr !== "-" ? `<a href="https://github.com/Interstellar-code/operator1/pull/${f.pr}">#${f.pr}</a>` : "-"}</td>
        <td><span class="b b-${f.status}">${f.status}</span></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.description}</td>
      </tr>`,
        )
        .join("")}</tbody></table>`
    }
  </div>
</div>

</div>

<!-- ==================== PLATFORM IMPROVEMENT ==================== -->
<div id="tab-platform" class="tc">

<h2 style="color:#58a6ff;margin-bottom:16px">Fix Pipeline</h2>
<div class="pipeline">
  <div class="pipe-step"><div class="num" style="color:#58a6ff">${diags.length}</div><div class="lbl">Detected</div></div>
  <div class="pipe-arrow">&rarr;</div>
  <div class="pipe-step"><div class="num" style="color:#d29922">${autoIssues.length}</div><div class="lbl">Issues Filed</div></div>
  <div class="pipe-arrow">&rarr;</div>
  <div class="pipe-step"><div class="num" style="color:#58a6ff">${fixes.length}</div><div class="lbl">Fix Attempted</div></div>
  <div class="pipe-arrow">&rarr;</div>
  <div class="pipe-step"><div class="num" style="color:#3fb950">${fixesVerified}</div><div class="lbl">Verified</div></div>
  <div class="pipe-step"><div class="num" style="color:#d29922">${fixesPending}</div><div class="lbl">Pending</div></div>
  <div class="pipe-step"><div class="num" style="color:#f85149">${fixesFailed}</div><div class="lbl">Failed</div></div>
</div>

<div class="sr">
  <div class="sc">
    <div class="num">${autoOpenIssues.length}</div>
    <div class="lbl">Open Issues</div>
  </div>
  <div class="sc">
    <div class="num">${autoClosedIssues.length}</div>
    <div class="lbl">Closed Issues</div>
  </div>
  <div class="sc">
    <div class="num">${autoOpenPRs.length}</div>
    <div class="lbl">Open PRs</div>
  </div>
  <div class="sc">
    <div class="num">${autoMergedPRs.length}</div>
    <div class="lbl">Merged PRs</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Fix Tracking</h2>
    ${
      fixes.length === 0
        ? '<div class="es">No fixes tracked yet. Auto-improve will create issues, auto-fix will attempt fixes.</div>'
        : `<table>
      <thead><tr><th>Issue</th><th>Category</th><th>Severity</th><th>PR</th><th>Files</th><th>Status</th><th>Description</th></tr></thead>
      <tbody>${fixes
        .map(
          (f: Record<string, string>) => `<tr>
        <td><a href="https://github.com/Interstellar-code/operator1/issues/${f.issue}">#${f.issue}</a></td>
        <td>${f.category}</td>
        <td><span class="b b-${f.severity}">${f.severity}</span></td>
        <td>${f.pr !== "-" ? `<a href="https://github.com/Interstellar-code/operator1/pull/${f.pr}">#${f.pr}</a>` : "-"}</td>
        <td>${f.files_changed || "-"}</td>
        <td><span class="b b-${f.status}">${f.status}</span></td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.description}</td>
      </tr>`,
        )
        .join("")}</tbody></table>`
    }
  </div>

  <div class="card">
    <h2>Category Breakdown</h2>
    ${diags.length === 0 && fixes.length === 0 ? '<div class="es">No data yet</div>' : `<div class="ch"><canvas id="categoryChart"></canvas></div>`}
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Issues (auto-improve)</h2>
    ${
      autoIssues.length === 0
        ? '<div class="es">No auto-improve issues</div>'
        : `<div class="scroll"><table>
      <thead><tr><th>#</th><th>Title</th><th>State</th><th>Labels</th><th>Created</th></tr></thead>
      <tbody>${autoIssues
        .map((i: Record<string, unknown>) => {
          const labels = Array.isArray(i.labels)
            ? (i.labels as Record<string, string>[]).map((l) => l.name).join(", ")
            : "";
          return `<tr>
          <td><a href="${i.url}">#${i.number}</a></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.title}</td>
          <td><span class="b b-${i.state}">${i.state}</span></td>
          <td style="font-size:11px">${labels}</td>
          <td>${String(i.createdAt || "").slice(0, 10)}</td>
        </tr>`;
        })
        .join("")}</tbody></table></div>`
    }
  </div>
  <div class="card">
    <h2>Pull Requests (auto-fix)</h2>
    ${
      autoPRs.length === 0
        ? '<div class="es">No auto-fix PRs</div>'
        : `<div class="scroll"><table>
      <thead><tr><th>#</th><th>Title</th><th>State</th><th>+/-</th><th>Created</th></tr></thead>
      <tbody>${autoPRs
        .map(
          (p: Record<string, unknown>) => `<tr>
        <td><a href="${p.url}">#${p.number}</a></td>
        <td style="max-width:350px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.title}</td>
        <td><span class="b b-${p.state}">${p.state}</span></td>
        <td><span style="color:#3fb950">+${p.additions || 0}</span> <span style="color:#f85149">-${p.deletions || 0}</span></td>
        <td>${String(p.createdAt || "").slice(0, 10)}</td>
      </tr>`,
        )
        .join("")}</tbody></table></div>`
    }
  </div>
</div>

</div>

<!-- ==================== HISTORY ==================== -->
<div id="tab-history" class="tc">

<div class="subtabs">
  <div class="subtab active" onclick="switchSubTab('agent-hist')">Agent Improvement History<span class="cnt">${results.length}</span></div>
  <div class="subtab" onclick="switchSubTab('platform-hist')">Platform Fix History<span class="cnt">${fixes.length}</span></div>
</div>

<div id="st-agent-hist" class="stc active">
<div class="card">
  <h2>Agent Improvement Iterations</h2>
  ${
    results.length === 0
      ? '<div class="es">No iterations yet</div>'
      : `<div class="scroll"><table id="agentHistTable">
    <thead><tr>
      <th onclick="sortTable('agentHistTable',0,'num')"># <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',1,'str')">Commit <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',2,'num')">Score <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',3,'num')">Del <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',4,'num')">Mem <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',5,'num')">Con <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',6,'num')">Silent <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',7,'num')">Errors <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('agentHistTable',8,'str')">Status <span class="sort-arrow">&#9650;</span></th>
      <th>Description</th>
    </tr></thead>
    <tbody>${results
      .map(
        (r: Record<string, string>, i: number) => `<tr>
      <td>${i + 1}</td>
      <td><code>${(r.commit || "-").slice(0, 7)}</code></td>
      <td><strong>${r.score}</strong></td>
      <td>${r.delegation}</td>
      <td>${r.memory}</td>
      <td>${r.conciseness}</td>
      <td>${r.silent_reply}</td>
      <td>${r.error_rate}</td>
      <td><span class="b b-${r.status}">${r.status}</span></td>
      <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.description || "").replace(/"/g, "&quot;")}">${r.description || ""}</td>
    </tr>`,
      )
      .join("")}</tbody></table></div>`
  }
</div>
</div>

<div id="st-platform-hist" class="stc">
<div class="card">
  <h2>Platform Fix Attempts</h2>
  ${
    fixes.length === 0
      ? '<div class="es">No fix attempts yet</div>'
      : `<div class="scroll"><table id="fixHistTable">
    <thead><tr>
      <th onclick="sortTable('fixHistTable',0,'num')">Issue <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('fixHistTable',1,'str')">Category <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('fixHistTable',2,'str')">Severity <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('fixHistTable',3,'num')">PR <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('fixHistTable',4,'num')">Files <span class="sort-arrow">&#9650;</span></th>
      <th onclick="sortTable('fixHistTable',5,'str')">Status <span class="sort-arrow">&#9650;</span></th>
      <th>Error Signature</th>
      <th>Description</th>
    </tr></thead>
    <tbody>${fixes
      .map(
        (f: Record<string, string>) => `<tr>
      <td><a href="https://github.com/Interstellar-code/operator1/issues/${f.issue}">#${f.issue}</a></td>
      <td>${f.category}</td>
      <td><span class="b b-${f.severity}">${f.severity}</span></td>
      <td>${f.pr !== "-" ? `<a href="https://github.com/Interstellar-code/operator1/pull/${f.pr}">#${f.pr}</a>` : "-"}</td>
      <td>${f.files_changed || "-"}</td>
      <td><span class="b b-${f.status}">${f.status}</span></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><code>${f.error_signature || ""}</code></td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.description || ""}</td>
    </tr>`,
      )
      .join("")}</tbody></table></div>`
  }
</div>
</div>

</div>

<div class="rn">Refresh: <code>bun .claude/skills/auto-improve/scripts/dashboard.ts</code> then reload</div>

<script>
// Tab switching
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tc').forEach(t => t.classList.remove('active'));
  event.target.closest('.tab').classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}
function switchSubTab(name) {
  const parent = event.target.closest('.tc');
  parent.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
  parent.querySelectorAll('.stc').forEach(t => t.classList.remove('active'));
  event.target.closest('.subtab').classList.add('active');
  document.getElementById('st-' + name).classList.add('active');
}

// Sortable tables
function sortTable(tableId, colIdx, type) {
  const table = document.getElementById(tableId);
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const th = table.querySelectorAll('th')[colIdx];
  const asc = !th.classList.contains('sorted') || th.dataset.dir === 'desc';
  table.querySelectorAll('th').forEach(h => { h.classList.remove('sorted'); delete h.dataset.dir; });
  th.classList.add('sorted');
  th.dataset.dir = asc ? 'asc' : 'desc';
  th.querySelector('.sort-arrow').textContent = asc ? '\\u25B2' : '\\u25BC';
  rows.sort((a, b) => {
    let va = a.cells[colIdx].textContent.trim();
    let vb = b.cells[colIdx].textContent.trim();
    if (type === 'num') {
      const na = parseFloat(va.replace('#','')) || 0;
      const nb = parseFloat(vb.replace('#','')) || 0;
      return asc ? na - nb : nb - na;
    }
    return asc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  rows.forEach(r => tbody.appendChild(r));
}

// Chart data
const trendData = ${agentTrendData};
const labels = trendData.map((_, i) => i + 1);

// Dataset definitions for each view
const datasets = {
  composite: [
    { label:'Composite', data:trendData.map(d=>d.score), borderColor:'#58a6ff', backgroundColor:'rgba(88,166,255,0.1)', fill:true, tension:0.3, pointRadius:3, borderWidth:2 },
    { label:'Delegation', data:trendData.map(d=>d.delegation), borderColor:'#f85149', borderDash:[4,4], tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Memory', data:trendData.map(d=>d.memory), borderColor:'#3fb950', borderDash:[4,4], tension:0.3, pointRadius:2, borderWidth:1.5 },
  ],
  op1: [
    { label:'Composite', data:trendData.map(d=>d.score), borderColor:'#58a6ff', fill:false, tension:0.3, pointRadius:3, borderWidth:2 },
    { label:'Delegation', data:trendData.map(d=>d.delegation), borderColor:'#f85149', tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Memory', data:trendData.map(d=>d.memory), borderColor:'#3fb950', tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Conciseness', data:trendData.map(d=>d.conciseness), borderColor:'#d29922', tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Silent Reply', data:trendData.map(d=>d.silent_reply), borderColor:'#a371f7', tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Write-Back', data:trendData.map(d=>d.op1_wb), borderColor:'#79c0ff', borderDash:[4,4], tension:0.3, pointRadius:2, borderWidth:1.5 },
  ],
  neo: [
    { label:'Exec Rate', data:trendData.map(d=>d.neo_exec), borderColor:'#58a6ff', tension:0.3, pointRadius:3, borderWidth:2 },
    { label:'Write-Back', data:trendData.map(d=>d.neo_wb), borderColor:'#3fb950', tension:0.3, pointRadius:2, borderWidth:1.5 },
  ],
  morpheus: [
    { label:'Exec Rate', data:trendData.map(d=>d.morpheus_exec), borderColor:'#58a6ff', tension:0.3, pointRadius:3, borderWidth:2 },
    { label:'Write-Back', data:trendData.map(d=>d.morpheus_wb), borderColor:'#3fb950', tension:0.3, pointRadius:2, borderWidth:1.5 },
  ],
  trinity: [
    { label:'Exec Rate', data:trendData.map(d=>d.trinity_exec), borderColor:'#58a6ff', tension:0.3, pointRadius:3, borderWidth:2 },
    { label:'Write-Back', data:trendData.map(d=>d.trinity_wb), borderColor:'#3fb950', tension:0.3, pointRadius:2, borderWidth:1.5 },
  ],
  all: [
    { label:'Composite', data:trendData.map(d=>d.score), borderColor:'#58a6ff', tension:0.3, pointRadius:2, borderWidth:2 },
    { label:'Neo Exec', data:trendData.map(d=>d.neo_exec), borderColor:'#f85149', borderDash:[4,4], tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Morpheus Exec', data:trendData.map(d=>d.morpheus_exec), borderColor:'#3fb950', borderDash:[4,4], tension:0.3, pointRadius:2, borderWidth:1.5 },
    { label:'Trinity Exec', data:trendData.map(d=>d.trinity_exec), borderColor:'#d29922', borderDash:[4,4], tension:0.3, pointRadius:2, borderWidth:1.5 },
  ],
};

const chartOpts = {
  responsive:true, maintainAspectRatio:false,
  scales: {
    x:{title:{display:true,text:'Iteration',color:'#8b949e'},ticks:{color:'#8b949e'},grid:{color:'#21262d'}},
    y:{min:0,max:1,title:{display:true,text:'Score',color:'#8b949e'},ticks:{color:'#8b949e'},grid:{color:'#21262d'}},
  },
  plugins:{legend:{labels:{color:'#c9d1d9',font:{size:11}}}},
};

let trendChart;
const ctx = document.getElementById('trendChart');
if (ctx) {
  trendChart = new Chart(ctx, { type:'line', data:{ labels, datasets:datasets.composite }, options:chartOpts });
}

// Current agent metrics for inline display
const agentMetrics = ${JSON.stringify(
  scores.reduce(
    (acc: Record<string, Record<string, unknown>>, s: Record<string, unknown>) => {
      acc[String(s.agent)] = {
        sessions: s.sessions_analyzed as number,
        composite: s.composite as number,
        delegation: s.delegation as number,
        memory: s.memory as number,
        conciseness: s.conciseness as number,
        silent_reply: s.silent_reply as number,
        error_rate: s.error_rate as number,
        exec_rate: s.tool_exec_rate as number,
        writeback: s.memory_writeback as number,
        richness: s.memory_richness as number,
        prompt_size: s.prompt_size as number,
        prompt_size_score: s.prompt_size_score as number,
        prompt_files: s.prompt_files,
        tool_efficiency: s.tool_efficiency as number,
        prompt_efficiency: s.prompt_efficiency as number,
        tool_call_count: s.tool_call_count as number,
        tool_calls_per_message: s.tool_calls_per_message as number,
      };
      return acc;
    },
    {} as Record<string, Record<string, unknown>>,
  ),
)};

const metricDefs = {
  composite: [],
  op1: [
    {k:'composite',l:'Composite'},{k:'delegation',l:'Delegation'},{k:'memory',l:'Memory'},
    {k:'conciseness',l:'Conciseness'},{k:'silent_reply',l:'Silent Reply'},{k:'error_rate',l:'Tool Errors'},
    {k:'exec_rate',l:'Exec Rate'},{k:'writeback',l:'Write-Back'},{k:'richness',l:'Richness'}
  ],
  neo: [{k:'exec_rate',l:'Exec Rate'},{k:'writeback',l:'Write-Back'},{k:'richness',l:'Richness'},{k:'memory',l:'Memory'}],
  morpheus: [{k:'exec_rate',l:'Exec Rate'},{k:'writeback',l:'Write-Back'},{k:'richness',l:'Richness'},{k:'memory',l:'Memory'}],
  trinity: [{k:'exec_rate',l:'Exec Rate'},{k:'writeback',l:'Write-Back'},{k:'richness',l:'Richness'},{k:'memory',l:'Memory'}],
  all: [],
};
const agentMap = {composite:'main',op1:'main',neo:'neo',morpheus:'morpheus',trinity:'trinity',all:'main'};

function renderLeftPanel(view) {
  const container = document.getElementById('leftMetricsContent');
  const agent = agentMetrics[agentMap[view]];
  if (!agent) return;

  const agentName = {composite:'Composite',op1:'Operator1 (main)',neo:'Neo',morpheus:'Morpheus',trinity:'Trinity',all:'All Agents'}[view];
  const defs = metricDefs[view] || [];

  const c = (v) => v >= 0.8 ? '#3fb950' : v >= 0.5 ? '#d29922' : '#f85149';
  const f = (v) => v >= 0 ? v.toFixed(3) : '-';
  const f2 = (v) => v >= 0 ? v.toFixed(2) : '-';

  if (view === 'composite' || view === 'all') {
    // Reset to default composite view
    const m = agentMetrics['main'];
    container.innerHTML =
      '<h2>Composite Score</h2>' +
      '<div class="mv">' + f2(m.composite) + '</div>' +
      '<div class="ml">Operator1 (main) &mdash; ' + m.sessions + ' sessions</div>' +
      '<div style="margin-top:16px"><h3>Metric Breakdown</h3><div class="sg">' +
      [{k:'delegation',l:'Delegation',w:'0.30'},{k:'memory',l:'Memory',w:'0.20'},{k:'conciseness',l:'Conciseness',w:'0.15'},{k:'silent_reply',l:'Silent Reply',w:'0.15'},{k:'error_rate',l:'Tool Errors',w:'0.20'}]
        .map(d => '<div class="si"><div class="v" style="color:'+c(m[d.k])+'">'+f2(m[d.k])+'</div><div class="l">'+d.l+' ('+d.w+')</div></div>').join('') +
      '</div></div>';
    return;
  }

  // Agent-specific view
  let html = '<h2>' + agentName + '</h2>';

  // Composite score for this agent
  if (agent.composite >= 0) {
    html += '<div class="mv" style="margin:8px 0">' + f(agent.composite) + '</div>';
    html += '<div class="ml" style="margin-bottom:12px">Composite &mdash; ' + agent.sessions + ' sessions</div>';
  }

  html += '<div style="margin-top:8px">';

  // Metrics grid
  if (defs.length) {
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">';
    defs.forEach(d => {
      const v = agent[d.k];
      html += '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px;text-align:center">' +
        '<div style="font-size:18px;font-weight:700;color:'+c(v)+'">'+ f(v) +'</div>' +
        '<div style="font-size:10px;color:#8b949e">'+d.l+'</div></div>';
    });
    html += '</div>';
  }

  // Prompt file breakdown
  const pf = agentMetrics[agentMap[view]];
  if (pf && pf.prompt_size >= 0) {
    html += '<h3>Prompt Files</h3>';
    html += '<div style="font-size:12px;margin-top:4px">';
    html += '<div class="mr"><span class="l">Total</span><span style="color:'+c(pf.prompt_size_score)+'"><strong>'+pf.prompt_size+' words</strong> ('+f(pf.prompt_size_score)+')</span></div>';
    if (pf.prompt_files) {
      pf.prompt_files.forEach(pfile => {
        const pct = pf.prompt_size > 0 ? Math.round(pfile.words / pf.prompt_size * 100) : 0;
        html += '<div class="mr"><span class="l">'+pfile.file+'</span><span>'+pfile.words+' ('+pct+'%)</span></div>';
      });
    }
    html += '</div>';
  }

  // Tool stats
  if (pf && pf.tool_call_count >= 0) {
    html += '<h3 style="margin-top:8px">Tool Usage</h3>';
    html += '<div style="font-size:12px;margin-top:4px">';
    html += '<div class="mr"><span class="l">Total Calls</span><span>'+pf.tool_call_count+'</span></div>';
    html += '<div class="mr"><span class="l">Calls/Message</span><span>'+pf.tool_calls_per_message.toFixed(1)+'</span></div>';
    html += '<div class="mr"><span class="l">Efficiency</span><span style="color:'+c(pf.tool_efficiency)+'">'+f(pf.tool_efficiency)+'</span></div>';
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function setChartView(view) {
  if (!trendChart) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  trendChart.data.datasets = datasets[view];
  trendChart.update();
  renderLeftPanel(view);
}

// Category breakdown chart
const catCtx = document.getElementById('categoryChart');
if (catCtx) {
  const cats = {};
  ${JSON.stringify(diags)}.forEach(d => { cats[d.category] = (cats[d.category]||0) + 1; });
  ${JSON.stringify(fixes)}.forEach(f => { cats[f.category] = (cats[f.category]||0) + 1; });
  const catLabels = Object.keys(cats);
  const catData = Object.values(cats);
  const catColors = ['#58a6ff','#f85149','#3fb950','#d29922','#a371f7','#79c0ff','#f778ba','#ffa657'];
  new Chart(catCtx, {
    type:'doughnut',
    data:{ labels:catLabels, datasets:[{ data:catData, backgroundColor:catColors.slice(0,catLabels.length), borderWidth:0 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'right',labels:{color:'#c9d1d9',font:{size:12}}}} },
  });
}
<\/script>
</body></html>`;

writeFileSync(OUTPUT_HTML, html);
console.log(`Dashboard generated: ${OUTPUT_HTML}`);
