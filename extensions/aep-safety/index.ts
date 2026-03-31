/**
 * AEP Safety Extension for OpenClaw/SafeClaw
 *
 * Embeds the AEP safety dashboard inside OpenClaw's web UI.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_PROXY_URL = "http://localhost:8899";

export default definePluginEntry({
  id: "aep-safety",
  name: "AEP Safety",
  description: "Safety enforcement, cost tracking, and signed verdicts for agents",
  register(api) {
    // State proxy — fetch from AEP proxy and forward
    api.registerHttpRoute({
      path: "/extensions/aep-safety/api/state",
      auth: "gateway",
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        try {
          const resp = await fetch(`${DEFAULT_PROXY_URL}/aep/api/state`);
          const data = await resp.text();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(data);
        } catch {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "AEP proxy unreachable", proxyUrl: DEFAULT_PROXY_URL }));
        }
      },
    });

    // Dashboard — embedded iframe to AEP proxy dashboard
    api.registerHttpRoute({
      path: "/extensions/aep-safety/",
      auth: "gateway",
      match: "prefix",
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(buildDashboardHTML());
      },
    });
  },
});

function buildDashboardHTML(): string {
  const proxyUrl = DEFAULT_PROXY_URL;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AEP Safety</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, monospace; }
  .header { padding: 16px 24px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #30363d; }
  .header h1 { font-size: 18px; color: #58a6ff; }
  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #8b949e; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
  .dot.off { background: #da3633; }
  .tabs { display: flex; gap: 0; margin-left: auto; }
  .tab { padding: 8px 16px; font-size: 13px; color: #8b949e; cursor: pointer; border: 1px solid #30363d; background: #161b22; }
  .tab:first-child { border-radius: 6px 0 0 6px; }
  .tab:last-child { border-radius: 0 6px 6px 0; }
  .tab.active { background: #58a6ff; color: #0d1117; font-weight: bold; }
  .frame { width: 100%; height: calc(100vh - 60px); border: none; }
</style>
</head>
<body>
<div class="header">
  <h1>AEP Safety</h1>
  <div class="status">
    <span class="dot" id="dot"></span>
    <span id="status-text">Checking proxy...</span>
  </div>
  <div class="tabs">
    <div class="tab active" id="tab-dev">Developer</div>
    <div class="tab" id="tab-ciso">Executive</div>
  </div>
</div>
<iframe id="frame" class="frame" src="${proxyUrl}/aep/"></iframe>
<script>
var proxyUrl = ${JSON.stringify(proxyUrl)};
document.getElementById('tab-dev').addEventListener('click', function() {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  this.classList.add('active');
  document.getElementById('frame').src = proxyUrl + '/aep/';
});
document.getElementById('tab-ciso').addEventListener('click', function() {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  this.classList.add('active');
  document.getElementById('frame').src = proxyUrl + '/aep/ciso';
});
async function checkProxy() {
  try {
    var r = await fetch('/extensions/aep-safety/api/state');
    if (r.ok) {
      document.getElementById('dot').className = 'dot';
      var d = await r.json();
      document.getElementById('status-text').textContent =
        'Connected (' + d.calls + ' calls, $' + d.cost.toFixed(4) + ')';
    } else {
      document.getElementById('dot').className = 'dot off';
      document.getElementById('status-text').textContent = 'Proxy error';
    }
  } catch(e) {
    document.getElementById('dot').className = 'dot off';
    document.getElementById('status-text').textContent = 'Proxy unreachable';
  }
}
checkProxy();
setInterval(checkProxy, 5000);
</script>
</body>
</html>`;
}
