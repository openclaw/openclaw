const { windowSec, maxRequests } = require('../lib/config');

function dashboardRoute(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clawhub Rate Limit Dashboard</title>
<style>
*{margin:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:2rem;width:400px}
h1{font-size:1.2rem;margin-bottom:1.5rem;color:#58a6ff}
.meter{background:#21262d;border-radius:8px;height:28px;overflow:hidden;margin:1rem 0}
.meter-fill{height:100%;border-radius:8px;transition:width .5s}
.green{background:#238636}.yellow{background:#d29922}.red{background:#da3633}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.stat{background:#0d1117;padding:.75rem;border-radius:8px;text-align:center}
.stat .val{font-size:1.5rem;font-weight:700;color:#f0f6fc}
.stat .lbl{font-size:.75rem;color:#8b949e;margin-top:.25rem}
#timer{color:#8b949e;text-align:center;margin-top:1rem;font-size:.85rem}
</style></head><body>
<div class="card">
<h1>🐾 Clawhub Rate Limit</h1>
<div class="meter"><div id="bar" class="meter-fill" style="width:0%"></div></div>
<div class="stats">
  <div class="stat"><div class="val" id="remaining">-</div><div class="lbl">Remaining</div></div>
  <div class="stat"><div class="val" id="limit">-</div><div class="lbl">Limit</div></div>
  <div class="stat"><div class="val" id="used">-</div><div class="lbl">Used</div></div>
  <div class="stat"><div class="val" id="window">-</div><div class="lbl">Window (s)</div></div>
</div>
<div id="timer"></div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/rate-limit/status');const d=await r.json();
    const pct=((d.limit-d.remaining)/d.limit)*100;
    document.getElementById('remaining').textContent=d.remaining;
    document.getElementById('limit').textContent=d.limit;
    document.getElementById('used').textContent=d.limit-d.remaining;
    document.getElementById('window').textContent=d.windowSec;
    const bar=document.getElementById('bar');
    bar.style.width=pct+'%';
    bar.className='meter-fill '+(pct<60?'green':pct<85?'yellow':'red');
    const sec=Math.max(0,d.reset-Math.ceil(Date.now()/1000));
    document.getElementById('timer').textContent='Resets in '+sec+'s';
  }catch(e){document.getElementById('timer').textContent='Error fetching status';}
}
refresh();setInterval(refresh,2000);
</script></body></html>`);
}

module.exports = { dashboardRoute };
