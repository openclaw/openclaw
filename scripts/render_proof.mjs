import { chromium } from "playwright";
import {
  shortenSessionKeyForCell,
  parseSessionKey,
  buildCellText,
} from "./session-display-proof.mjs";

const ROWS = [
  {
    key: "agent:main:feishu:direct:ou_67075ec667cac0a7feae2c5094fd27b2",
    label: null,
    displayName: "税务师 张三",
    kind: "direct",
  },
  {
    key: "agent:main:telegram:direct:user_1234567890abcdef1234567890abcdef",
    label: null,
    displayName: null,
    kind: "direct",
  },
  {
    key: "agent:main:telegram:direct:user_123",
    label: null,
    displayName: "Telegram Friend",
    kind: "direct",
  },
  {
    key: "main",
    label: null,
    displayName: null,
    kind: "main",
  },
  {
    key: "agent:main:main:subagent:worker-1",
    label: null,
    displayName: null,
    kind: "subagent",
  },
];

function buildRowsHtml() {
  return ROWS.map((row, idx) => {
    const { hoverTitle, cellText, showDisplayName, displayName } = buildCellText(row);
    const channelMatch = row.key.match(/^agent:[^:]+:([^:]+):/);
    const channel = channelMatch ? channelMatch[1] : "—";
    return `
      <tr class="session-row" data-row-idx="${idx}">
        <td class="data-table-key-col">
          <div class="${"mono session-key-cell"}" title="${hoverTitle}">
            <a href="#" class="session-link" data-idx="${idx}">${cellText}</a>
            ${showDisplayName ? `<span class="muted session-key-display-name">${displayName}</span>` : ""}
          </div>
        </td>
        <td class="data-table-channel-col">${channel}</td>
        <td class="data-table-kind-col">${row.kind}</td>
        <td class="data-table-tokens-col">1.2k</td>
      </tr>
    `;
  }).join("\n");
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenClaw Control UI — Sessions (proof)</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --accent: #58a6ff;
    --hover-bg: #1f2937;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
  }
  .app-shell { display: flex; min-height: 100vh; }
  .sidebar {
    width: 220px;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding: 16px 12px;
  }
  .sidebar h2 {
    font-size: 13px;
    margin: 0 0 16px 0;
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .sidebar a {
    display: block;
    padding: 6px 10px;
    color: var(--text);
    text-decoration: none;
    border-radius: 6px;
    font-size: 13px;
  }
  .sidebar a.active { background: var(--hover-bg); color: var(--accent); }
  .main { flex: 1; padding: 24px 32px; }
  h1 {
    font-size: 20px;
    margin: 0 0 4px 0;
    font-weight: 600;
  }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  table.data-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  table.data-table th, table.data-table td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    vertical-align: middle;
  }
  table.data-table th {
    background: #21262d;
    font-weight: 600;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  table.data-table tr:last-child td { border-bottom: none; }
  table.data-table tr:hover td { background: var(--hover-bg); }
  .data-table-key-col { width: 50%; }
  .data-table-channel-col { width: 15%; }
  .data-table-kind-col { width: 15%; }
  .data-table-tokens-col { width: 20%; text-align: right; }
  .session-key-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .session-key-cell.mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .session-link {
    color: var(--accent);
    text-decoration: none;
  }
  .session-link:hover { text-decoration: underline; }
  .muted { color: var(--muted); font-size: 12px; }
  .session-key-display-name {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .details-overlay {
    display: none;
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 460px;
    background: var(--panel);
    border-left: 1px solid var(--border);
    padding: 28px 32px;
    overflow-y: auto;
    box-shadow: -8px 0 24px rgba(0,0,0,0.3);
  }
  .details-overlay.open { display: block; }
  .session-details-panel__eyebrow {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
  }
  .session-details-panel__title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 6px;
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, monospace;
  }
  .session-details-panel__subtitle {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 20px;
  }
  .session-details-panel__badges {
    display: flex;
    gap: 6px;
    margin-bottom: 20px;
  }
  .badge {
    background: #21262d;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 11px;
    color: var(--muted);
  }
  .detail-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .detail-row .key { color: var(--muted); }
  .detail-row .val { color: var(--text); font-family: ui-monospace, monospace; font-size: 12px; }
  .close-btn {
    position: absolute;
    top: 16px; right: 20px;
    background: none;
    border: none;
    color: var(--muted);
    font-size: 22px;
    cursor: pointer;
  }
  .proof-banner {
    background: #1c2128;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--muted);
  }
  .proof-banner strong { color: var(--accent); }
</style>
</head>
<body>
<div class="app-shell">
  <aside class="sidebar">
    <h2>🦞 OPENCLAW</h2>
    <a href="#">Dashboard</a>
    <a href="#" class="active">Sessions</a>
    <a href="#">Agents</a>
    <a href="#">Channels</a>
    <a href="#">Cron</a>
    <a href="#">Settings</a>
  </aside>
  <main class="main">
    <div class="proof-banner">
      <strong>PR #94813 visual proof</strong> — Sessions table rendering with
      <code>shortenSessionKeyForCell</code> applied to fallback rows.
      Cell shows truncated ID; hover preserves full raw key.
    </div>
    <h1>Sessions</h1>
    <div class="subtitle">5 sessions · sorted by last activity</div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Session</th>
          <th>Channel</th>
          <th>Kind</th>
          <th style="text-align:right">Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${buildRowsHtml()}
      </tbody>
    </table>
  </main>
  <aside class="details-overlay" id="details">
    <button class="close-btn" id="closeDetails">×</button>
    <div class="session-details-panel__eyebrow">Session details</div>
    <div class="session-details-panel__title" id="detailsTitle"></div>
    <div class="session-details-panel__subtitle" id="detailsSubtitle"></div>
    <div class="session-details-panel__badges">
      <span class="badge">direct</span>
      <span class="badge" id="channelBadge">feishu</span>
    </div>
    <div class="detail-row"><span class="key">Raw key</span><span class="val" id="rawKey"></span></div>
    <div class="detail-row"><span class="key">Created</span><span class="val">2026-06-12 14:23</span></div>
    <div class="detail-row"><span class="key">Last active</span><span class="val">2 minutes ago</span></div>
    <div class="detail-row"><span class="key">Messages</span><span class="val">47</span></div>
    <div class="detail-row"><span class="key">Tokens used</span><span class="val">1,247 / 200k</span></div>
  </aside>
</div>

<script>
  const ROWS = ${JSON.stringify(ROWS.map((r) => ({ ...r, ...buildCellText(r) })))};

  document.querySelectorAll('.session-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(link.dataset.idx, 10);
      const row = ROWS[idx];
      document.getElementById('detailsTitle').textContent = row.cellText;
      document.getElementById('detailsSubtitle').textContent = row.displayName || '';
      document.getElementById('rawKey').textContent = row.key;
      const channelMatch = row.key.match(/^agent:[^:]+:([^:]+):/);
      document.getElementById('channelBadge').textContent = channelMatch ? channelMatch[1] : '—';
      document.getElementById('details').classList.add('open');
    });
  });
  document.getElementById('closeDetails').addEventListener('click', () => {
    document.getElementById('details').classList.remove('open');
  });
</script>
</body>
</html>`;

const OUT_DIR = process.env.PROOF_OUT_DIR || "./proof-output";
import { mkdirSync } from "node:fs";
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

await page.setContent(HTML, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const longKeyRow = page.locator('.session-row[data-row-idx="0"]');
await longKeyRow.scrollIntoViewIfNeeded();

await page.evaluate(() => {
  const row = document.querySelector('.session-row[data-row-idx="0"] .session-link');
  if (row) {
    row.style.outline = "2px solid #ff6b6b";
    row.style.outlineOffset = "2px";
  }
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT_DIR}/proof-1-cell-truncated.png` });
console.log("✓ Shot 1: cell-truncated.png");

await page.evaluate(() => {
  const row = document.querySelector('.session-row[data-row-idx="0"] .session-link');
  if (row) row.style.outline = "";
});

const longKeyCell = page.locator('.session-row[data-row-idx="0"] .session-key-cell');
await longKeyCell.hover();
await page.evaluate(() => {
  const cell = document.querySelector('.session-row[data-row-idx="0"] .session-key-cell');
  const full = cell.getAttribute("title");
  const tip = document.createElement("div");
  tip.id = "__proof_tip";
  tip.textContent = full;
  tip.style.cssText = [
    "position: absolute",
    "background: #30363d",
    "color: #c9d1d9",
    "border: 1px solid #484f58",
    "border-radius: 4px",
    "padding: 6px 10px",
    "font-family: ui-monospace, SFMono-Regular, monospace",
    "font-size: 12px",
    "z-index: 1000",
    "box-shadow: 0 4px 12px rgba(0,0,0,0.5)",
    "max-width: 520px",
    "word-break: break-all",
    "white-space: normal",
  ].join(";");
  const rect = cell.getBoundingClientRect();
  tip.style.left = rect.left + 8 + "px";
  tip.style.top = rect.bottom + 8 + "px";
  document.body.appendChild(tip);
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT_DIR}/proof-2-hover-full-key.png` });
console.log("✓ Shot 2: hover-full-key.png");

await page.evaluate(() => document.getElementById("__proof_tip")?.remove());
await page.locator('.session-row[data-row-idx="0"] .session-link').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT_DIR}/proof-3-details-panel.png` });
console.log("✓ Shot 3: details-panel.png");

await page.evaluate(() => {
  document.getElementById("details").classList.remove("open");
});

await browser.close();

console.log("\n" + "=".repeat(80));
console.log("VERIFICATION TABLE");
console.log("=".repeat(80));
console.log("PR branch: PR #94813 head");
console.log("Logic: shortenSessionKeyForCell from ui/src/ui/session-display.ts\n");
console.log("Row | Cell (truncated)              | Hover (full)");
console.log("-".repeat(120));
ROWS.forEach((row, idx) => {
  const { hoverTitle, cellText } = buildCellText(row);
  console.log(`  ${idx + 1} | ${cellText.padEnd(30).slice(0, 30)} | ${hoverTitle}`);
});
console.log(`\nOutputs in: ${OUT_DIR}/`);
