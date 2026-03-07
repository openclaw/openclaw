"""Admin Marketing Control Panel — one page to control all five optimization engines.

GET /admin/marketing — serves the Marketing Control Panel HTML page
POST /admin/marketing/{engine}/simulate — simulate an engine cycle
POST /admin/marketing/{engine}/apply — apply an engine cycle (requires write_lock off)

Engines:
1. Offer Rotation — daily combo rotation cycle
2. Authority Scheduler — seed weekly content queue
3. VSL Optimizer — variant performance + suggestions
4. Setter Routing — route sample lead + explain
5. Retainer Funnel — list candidates + generate assets
"""
from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse

from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("admin.marketing")

router = APIRouter()


def _get_conn(request: Request) -> sqlite3.Connection:
    """Get DB connection from app state."""
    conn = getattr(request.app.state, "db", None)
    if conn is None:
        conn = sqlite3.connect(settings.SQLITE_PATH)
        conn.row_factory = sqlite3.Row
    return conn


def _check_admin(request: Request) -> bool:
    """Verify admin token."""
    token = request.headers.get("X-Admin-Token", "")
    return token == settings.ADMIN_OPS_TOKEN and token != ""


# ── API endpoints ──


@router.post("/offer-rotation/{mode}")
async def offer_rotation(mode: str, request: Request) -> JSONResponse:
    """Run offer rotation cycle (simulate or apply)."""
    if not _check_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    safe_mode = mode != "apply"
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    brand = body.get("brand", "fulldigital")

    if not safe_mode and settings.NOTION_WRITE_LOCK:
        return JSONResponse({"error": "write_lock is ON"}, status_code=423)

    from packages.agencyu.marketing.offer_angles import run_rotation_cycle
    conn = _get_conn(request)
    result = run_rotation_cycle(conn, brand, safe_mode=safe_mode)
    return JSONResponse(result)


@router.post("/authority-scheduler/{mode}")
async def authority_scheduler(mode: str, request: Request) -> JSONResponse:
    """Seed authority content queue (simulate or apply)."""
    if not _check_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    safe_mode = mode != "apply"
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    brand = body.get("brand", "fulldigital")

    if not safe_mode and settings.NOTION_WRITE_LOCK:
        return JSONResponse({"error": "write_lock is ON"}, status_code=423)

    from packages.agencyu.marketing.authority_scheduler import seed_content_queue
    conn = _get_conn(request)
    result = seed_content_queue(conn, brand, safe_mode=safe_mode)
    return JSONResponse(result)


@router.post("/vsl-optimizer/{mode}")
async def vsl_optimizer(mode: str, request: Request) -> JSONResponse:
    """Run VSL optimization cycle."""
    if not _check_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    from packages.agencyu.marketing.vsl_optimizer import run_vsl_optimization_cycle
    conn = _get_conn(request)
    result = run_vsl_optimization_cycle(conn, window_days=30)
    return JSONResponse(result)


@router.post("/setter-routing/{mode}")
async def setter_routing(mode: str, request: Request) -> JSONResponse:
    """Route a sample lead or explain routing logic."""
    if not _check_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    brand = body.get("brand", "fulldigital")
    lead = body.get("lead", {"contact_key": "sample_lead", "application_score": 65})

    from packages.agencyu.marketing.setter_router import explain_routing
    conn = _get_conn(request)
    result = explain_routing(conn, brand, lead)
    return JSONResponse(result)


@router.post("/retainer-funnel/{mode}")
async def retainer_funnel(mode: str, request: Request) -> JSONResponse:
    """Run retainer candidate scan (simulate or apply)."""
    if not _check_admin(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    safe_mode = mode != "apply"

    if not safe_mode and settings.NOTION_WRITE_LOCK:
        return JSONResponse({"error": "write_lock is ON"}, status_code=423)

    from packages.agencyu.marketing.retainer_funnel import run_retainer_scan
    conn = _get_conn(request)
    result = run_retainer_scan(conn, safe_mode=safe_mode)
    return JSONResponse(result)


# ── HTML UI ──


_MARKETING_HTML = """\
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Full Digital — Marketing Control Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; max-width: 960px; background: #fafafa; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 20px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    .card h3 { margin: 0 0 8px; font-size: 16px; }
    .card p { font-size: 13px; color: #555; margin: 0 0 12px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
    button { padding: 8px 16px; border: 0; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600; }
    button:disabled { opacity: .4; cursor: not-allowed; }
    .btn-sim { background: #f3f4f6; color: #111; }
    .btn-sim:hover:not(:disabled) { background: #e5e7eb; }
    .btn-apply { background: #111; color: #fff; }
    .btn-apply:hover:not(:disabled) { background: #333; }
    pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; overflow: auto; max-height: 350px; font-size: 12px; }
    .status { font-size: 12px; color: #999; margin-top: 6px; }
    input { padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; }
    label { font-size: 12px; color: #666; display: block; margin-bottom: 3px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-yellow { background: #fef9c3; color: #854d0e; }
    .badge-red { background: #fecaca; color: #991b1b; }
  </style>
</head>
<body>
  <h1>Marketing Control Panel</h1>
  <p class="subtitle">5 optimization engines — simulate first, then apply. All respect SAFE_MODE + write_lock.</p>

  <div class="row" style="margin-bottom: 16px;">
    <div>
      <label>Admin Token</label>
      <input id="token" type="password" placeholder="X-Admin-Token" style="width: 280px;" />
    </div>
    <div>
      <label>Brand</label>
      <select id="brand" style="padding: 8px; border-radius: 8px; border: 1px solid #ddd;">
        <option value="fulldigital">Full Digital</option>
        <option value="cutmv">CUTMV</option>
      </select>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>🔄 Offer Rotation</h3>
      <p>Evaluate active combos: hold / rotate / promote / kill. Fatigue-aware.</p>
      <div class="row">
        <button class="btn-sim" onclick="run('offer-rotation','simulate')">Simulate</button>
        <button class="btn-apply" onclick="run('offer-rotation','apply')">Apply</button>
      </div>
      <div class="status" id="offer-rotation-status"></div>
      <pre id="offer-rotation-out">{}</pre>
    </div>

    <div class="card">
      <h3>📅 Authority Scheduler</h3>
      <p>Seed weekly content queue based on authority score + KPI gap.</p>
      <div class="row">
        <button class="btn-sim" onclick="run('authority-scheduler','simulate')">Simulate</button>
        <button class="btn-apply" onclick="run('authority-scheduler','apply')">Apply</button>
      </div>
      <div class="status" id="authority-scheduler-status"></div>
      <pre id="authority-scheduler-out">{}</pre>
    </div>

    <div class="card">
      <h3>📹 VSL Optimizer</h3>
      <p>Variant performance: best/worst + retention diagnosis + suggestions.</p>
      <div class="row">
        <button class="btn-sim" onclick="run('vsl-optimizer','simulate')">Analyze</button>
      </div>
      <div class="status" id="vsl-optimizer-status"></div>
      <pre id="vsl-optimizer-out">{}</pre>
    </div>

    <div class="card">
      <h3>🎯 Setter Routing</h3>
      <p>Route a sample lead — shows quality score, setter rankings, explain.</p>
      <div class="row">
        <button class="btn-sim" onclick="run('setter-routing','simulate')">Explain Routing</button>
      </div>
      <div class="status" id="setter-routing-status"></div>
      <pre id="setter-routing-out">{}</pre>
    </div>

    <div class="card">
      <h3>🔁 Retainer Funnel</h3>
      <p>Detect candidates, generate pitch assets. Never auto-sends.</p>
      <div class="row">
        <button class="btn-sim" onclick="run('retainer-funnel','simulate')">Simulate</button>
        <button class="btn-apply" onclick="run('retainer-funnel','apply')">Apply</button>
      </div>
      <div class="status" id="retainer-funnel-status"></div>
      <pre id="retainer-funnel-out">{}</pre>
    </div>
  </div>

<script>
async function run(engine, mode) {
  var st = document.getElementById(engine + '-status');
  var out = document.getElementById(engine + '-out');
  st.textContent = 'Running ' + engine + ' (' + mode + ')...';
  out.textContent = '';
  try {
    var res = await fetch('/admin/marketing/' + engine + '/' + mode, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': document.getElementById('token').value
      },
      body: JSON.stringify({ brand: document.getElementById('brand').value })
    });
    var json = await res.json();
    out.textContent = JSON.stringify(json, null, 2);
    st.textContent = json.ok ? 'Done.' : (json.error || 'Completed with issues.');
  } catch (e) {
    st.textContent = 'Error: ' + e.message;
  }
}
</script>
</body>
</html>
"""


@router.get("", response_class=HTMLResponse)
def marketing_control_panel() -> HTMLResponse:
    """Serve the Marketing Control Panel."""
    return HTMLResponse(_MARKETING_HTML)
