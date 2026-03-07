"""Admin Today Panel — Command Center for starting the day.

Endpoints:
  GET  /admin/today            — HTML page (brand chips + schedule + overdue + start button)
  POST /admin/today/start_day  — runs sync → heal → refresh widgets
  GET  /admin/today/status     — last run + current state
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse

from packages.agencyu.marketing.metrics_daily import (
    build_brand_tile_summary,
    delta_arrow,
    trend_color,
)
from packages.agencyu.schedule.query import (
    count_overdue_deadlines,
    get_next_up,
    get_today_schedule,
    get_today_schedule_focus,
    list_overdue_deadlines,
)
from packages.agencyu.schedule.repo import GoalRepo
from packages.agencyu.schedule.sync_engine import (
    finish_sync_run,
    get_last_sync_run,
    record_sync_run,
    run_daily_sync,
)
from packages.common.config import settings
from packages.common.cooldown import get_cooldown
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.admin_today")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


# ── Data helpers ──


def _build_today_data(focus_hours: int | None = None) -> dict[str, Any]:
    """Build all data needed for the Today panel."""
    # Brand KPI chips
    tile_summary = build_brand_tile_summary(_conn)
    fd_s = tile_summary["fulldigital"]
    cm_s = tile_summary["cutmv"]
    fd_delta = fd_s["calls_booked_today"] - fd_s["calls_booked_yesterday"]
    cm_delta = cm_s["paid_today"] - cm_s["paid_yesterday"]

    # Goal chips
    goal_repo = GoalRepo(_conn)
    fd_goal = goal_repo.build_goal_chip("fulldigital", "daily")
    cm_goal = goal_repo.build_goal_chip("cutmv", "daily")

    # Schedule
    schedule = get_today_schedule(_conn, simple_mode=True, limit=15)
    next_up = get_next_up(_conn, limit=5)
    overdue_count = count_overdue_deadlines(_conn)
    overdue_list = list_overdue_deadlines(_conn, limit=5)

    # Focus window
    allowlist = [t.strip() for t in settings.TODAY_ALL_DAY_TYPE_ALLOWLIST.split(",") if t.strip()]
    effective_hours = focus_hours if focus_hours is not None else settings.TODAY_FOCUS_WINDOW_HOURS
    # 0 = rest of day (use 24h to capture everything)
    query_hours = effective_hours if effective_hours > 0 else 24
    focus = get_today_schedule_focus(
        _conn,
        focus_hours=query_hours,
        timezone=settings.TODAY_TIMEZONE,
        include_all_day_deadlines=settings.TODAY_INCLUDE_ALL_DAY_DEADLINES,
        all_day_type_allowlist=allowlist,
        max_items=settings.TODAY_MAX_ITEMS,
    )
    # Override focus_hours in result for dropdown display
    focus["focus_hours"] = effective_hours

    # Last sync
    last_gcal = get_last_sync_run(_conn, "schedule_pull_gcal")
    last_trello = get_last_sync_run(_conn, "schedule_pull_trello_due")

    return {
        "brands": {
            "fulldigital": {
                "kpi_line": (
                    f"Today \u2022 {fd_s['calls_booked_today']} booked calls"
                    f"  {delta_arrow(fd_delta)} {fd_delta:+d} vs yesterday"
                ),
                "goal_chip": fd_goal.chip_text if fd_goal else "",
                "trend_color": trend_color(fd_delta),
            },
            "cutmv": {
                "kpi_line": (
                    f"Today \u2022 {cm_s['trials_today']} trials \u2022 {cm_s['paid_today']} paid"
                    f"  {delta_arrow(cm_delta)} {cm_delta:+d} vs yesterday"
                ),
                "goal_chip": cm_goal.chip_text if cm_goal else "",
                "trend_color": trend_color(cm_delta),
            },
        },
        "schedule": schedule,
        "next_up": next_up,
        "overdue_count": overdue_count,
        "overdue_list": overdue_list,
        "focus": focus,
        "last_sync": {
            "gcal": last_gcal,
            "trello": last_trello,
        },
    }


# ── Endpoints ──


@router.get("", response_class=HTMLResponse)
def admin_today_page(
    _: None = Depends(require_admin_ops_token),
    focus_hours: int | None = Query(None, ge=0, le=24, description="Focus window hours (0=rest of day)"),
) -> HTMLResponse:
    """Render the Today Command Center HTML page."""
    data = _build_today_data(focus_hours=focus_hours)
    html = _render_today_html(data)
    return HTMLResponse(content=html)


@router.post("/start_day")
def admin_start_day(
    _: None = Depends(require_admin_ops_token),
    safe: bool = Query(False, description="Dry run mode"),
) -> dict[str, Any]:
    """Start the day: sync schedule → heal views → refresh widgets.

    Respects write_lock + cooldown + runaway prevention.
    """
    cooldown = get_cooldown(_conn)
    if cooldown.get("active"):
        return {
            "ok": True,
            "skipped": True,
            "reason": "cooldown_active",
            "cooldown": cooldown,
            "data": _build_today_data(),
        }

    results: dict[str, Any] = {"started_at": datetime.now(UTC).isoformat()}

    # Step 1: Schedule sync (GCal + Trello)
    sync_results: dict[str, Any] = {}

    # GCal pull
    if settings.GOOGLE_SERVICE_ACCOUNT_KEY_PATH and not safe:
        run_id = record_sync_run(_conn, "schedule_pull_gcal", "gcal")
        try:
            from packages.agencyu.schedule.gcal_provider import GCalProvider, sync_gcal_to_schedule

            calendar_ids = json.loads(settings.GCAL_CALENDAR_IDS_JSON)
            provider = GCalProvider(
                service_account_key=settings.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
                impersonate_email=settings.GOOGLE_IMPERSONATE_EMAIL,
                calendar_ids=calendar_ids,
                write_enabled=settings.GCAL_WRITE_ENABLED,
            )
            repo_mod = __import__("packages.agencyu.schedule.repo", fromlist=["ScheduleRepo"])
            repo = repo_mod.ScheduleRepo(_conn)
            gcal_result = sync_gcal_to_schedule(
                provider, repo, "fulldigital",
                past_days=settings.SCHEDULE_SYNC_WINDOW_PAST_DAYS,
                future_days=settings.SCHEDULE_SYNC_WINDOW_FUTURE_DAYS,
            )
            finish_sync_run(_conn, run_id, events_synced=gcal_result.get("synced", 0))
            sync_results["gcal"] = gcal_result
        except Exception as exc:
            finish_sync_run(_conn, run_id, status="error", details={"error": str(exc)})
            sync_results["gcal"] = {"error": str(exc)}
    else:
        sync_results["gcal"] = {"skipped": True}

    # Trello pull
    if settings.TRELLO_KEY and settings.TRELLO_TOKEN and not safe:
        run_id = record_sync_run(_conn, "schedule_pull_trello_due", "trello")
        try:
            from packages.agencyu.schedule.trello_due_sync import sync_board_due_dates
            from packages.integrations.trello.client import TrelloClient

            trello = TrelloClient()
            repo_mod = __import__("packages.agencyu.schedule.repo", fromlist=["ScheduleRepo"])
            repo = repo_mod.ScheduleRepo(_conn)
            board_id = settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID
            if board_id:
                trello_result = sync_board_due_dates(trello, repo, board_id, "fulldigital")
                finish_sync_run(_conn, run_id, events_synced=trello_result.get("synced", 0))
                sync_results["trello"] = trello_result
            else:
                finish_sync_run(_conn, run_id, status="success")
                sync_results["trello"] = {"skipped": True, "reason": "no board configured"}
        except Exception as exc:
            finish_sync_run(_conn, run_id, status="error", details={"error": str(exc)})
            sync_results["trello"] = {"error": str(exc)}
    else:
        sync_results["trello"] = {"skipped": True}

    # Step 2: Build daily plans
    if not safe:
        daily_result = run_daily_sync(_conn)
        results["daily_sync"] = daily_result

    results["sync"] = sync_results
    results["finished_at"] = datetime.now(UTC).isoformat()

    # Return fresh data
    results["data"] = _build_today_data()
    results["ok"] = True
    return results


@router.get("/status")
def admin_today_status(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Current Today panel state + last sync info."""
    data = _build_today_data()
    cooldown = get_cooldown(_conn)

    return {
        "ok": True,
        "data": data,
        "cooldown_active": cooldown.get("active", False),
        "ts": datetime.now(UTC).isoformat(),
    }


_OVERDUE_CLEAR_HTML = '<div style="color:#22c55e">None \u2014 all clear</div>'


# ── HTML renderer ──


def _render_today_html(data: dict[str, Any]) -> str:
    """Render the Today panel as a minimal HTML page."""
    fd = data["brands"]["fulldigital"]
    cm = data["brands"]["cutmv"]
    focus = data.get("focus", {})
    focus_hours = focus.get("focus_hours", settings.TODAY_FOCUS_WINDOW_HOURS)

    # Brand chip rows
    fd_color = {"green": "#22c55e", "red": "#ef4444", "yellow": "#eab308"}.get(fd["trend_color"], "#6b7280")
    cm_color = {"green": "#22c55e", "red": "#ef4444", "yellow": "#eab308"}.get(cm["trend_color"], "#6b7280")

    fd_goal_html = f' <span style="color:#6b7280">|</span> <span style="color:#3b82f6">{fd["goal_chip"]}</span>' if fd["goal_chip"] else ""
    cm_goal_html = f' <span style="color:#6b7280">|</span> <span style="color:#3b82f6">{cm["goal_chip"]}</span>' if cm["goal_chip"] else ""

    # Up Next rows (timed events in focus window)
    up_next_rows = ""
    for item in focus.get("up_next", []):
        conflict_badge = ' <span style="color:#ef4444;font-weight:600">!</span>' if item.get("conflict") else ""
        source_badge = f'<span style="color:#9ca3af;font-size:11px">{item["source"]}</span>'
        up_next_rows += f"""
        <tr>
          <td style="padding:4px 8px;color:#6b7280;white-space:nowrap">{item["time"]}</td>
          <td style="padding:4px 8px">{item["title"]}{conflict_badge}</td>
          <td style="padding:4px 8px;color:#9ca3af">{item["brand"]}</td>
          <td style="padding:4px 8px">{source_badge}</td>
        </tr>"""

    # Today's Deadlines rows (allowlisted all-day items)
    deadline_rows = ""
    for item in focus.get("deadlines", []):
        source_badge = f'<span style="color:#9ca3af;font-size:11px">{item["source"]}</span>'
        deadline_rows += f"""
        <tr>
          <td style="padding:4px 8px;color:#f59e0b">Due</td>
          <td style="padding:4px 8px">{item["title"]}</td>
          <td style="padding:4px 8px;color:#9ca3af">{item["brand"]}</td>
          <td style="padding:4px 8px">{source_badge}</td>
        </tr>"""

    # Overdue rows
    overdue_rows = ""
    for item in data["overdue_list"][:5]:
        overdue_rows += f"""
        <div style="padding:4px 0;color:#ef4444">{item["title"]} <span style="color:#9ca3af">({item["brand"]})</span></div>"""

    up_next_empty = '<tr><td colspan="4" style="padding:8px;color:#6b7280">No timed events in this window</td></tr>'
    deadline_empty = '<tr><td colspan="4" style="padding:8px;color:#6b7280">No deadlines today</td></tr>'

    # Focus hours dropdown options
    def _option(val: int) -> str:
        sel = " selected" if val == focus_hours else ""
        label = f"{val}h" if val > 0 else "Rest of day"
        return f'<option value="{val}"{sel}>{label}</option>'

    dropdown_options = _option(10) + _option(6) + _option(3) + _option(0)

    return f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Today \u2014 OpenClaw</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0f172a; color:#e2e8f0; padding:24px; max-width:960px; margin:0 auto; }}
  h1 {{ font-size:24px; margin-bottom:16px; }}
  .chip {{ display:inline-block; padding:6px 14px; border-radius:8px; background:#1e293b; margin:4px 0; font-size:14px; }}
  .section {{ background:#1e293b; border-radius:12px; padding:16px; margin:16px 0; }}
  .section h2 {{ font-size:16px; margin-bottom:12px; color:#94a3b8; }}
  table {{ width:100%; border-collapse:collapse; }}
  tr:hover {{ background:#334155; }}
  .btn {{ display:inline-block; padding:10px 24px; background:#3b82f6; color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; }}
  .btn:hover {{ background:#2563eb; }}
  .btn:disabled {{ background:#475569; cursor:not-allowed; }}
  .status {{ display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }}
  .toast {{ position:fixed; top:16px; right:16px; padding:12px 20px; border-radius:8px; font-size:13px; display:none; z-index:100; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
  select.focus-select {{ background:#334155; color:#e2e8f0; border:1px solid #475569; border-radius:6px; padding:2px 8px; font-size:12px; cursor:pointer; }}
  @media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} }}
</style>
</head><body>
<h1><span class="status" id="health-dot" style="background:#22c55e"></span> Today</h1>

<div class="section">
  <div class="chip" style="border-left:3px solid {fd_color}">
    <strong>Full Digital</strong> \u2014 {fd["kpi_line"]}{fd_goal_html}
  </div><br>
  <div class="chip" style="border-left:3px solid {cm_color}">
    <strong>CUTMV</strong> \u2014 {cm["kpi_line"]}{cm_goal_html}
  </div>
</div>

<div class="grid">
  <div class="section">
    <h2>
      Up Next
      <select class="focus-select" id="focus-select" onchange="changeFocus(this.value)">
        {dropdown_options}
      </select>
    </h2>
    <table>{up_next_rows if up_next_rows else up_next_empty}</table>
  </div>

  <div class="section">
    <h2>Today's Deadlines</h2>
    <table>{deadline_rows if deadline_rows else deadline_empty}</table>
  </div>
</div>

<div class="section">
  <h2>Overdue <span style="color:#ef4444;font-weight:700">{data["overdue_count"]}</span></h2>
  {overdue_rows if overdue_rows else _OVERDUE_CLEAR_HTML}
</div>

<div style="margin-top:16px;text-align:center">
  <button class="btn" id="start-btn" onclick="startDay()">Start the day</button>
  <div id="start-status" style="margin-top:8px;font-size:12px;color:#94a3b8"></div>
</div>

<div class="toast" id="toast"></div>

<script>
const token = new URLSearchParams(window.location.search).get('token') || '';

function changeFocus(hours) {{
  const url = new URL(window.location);
  url.searchParams.set('focus_hours', hours);
  window.location = url.toString();
}}

function startDay() {{
  const btn = document.getElementById('start-btn');
  const status = document.getElementById('start-status');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  status.textContent = 'Running schedule sync + refresh...';

  fetch('/admin/today/start_day?token=' + token, {{method:'POST'}})
    .then(r => r.json())
    .then(d => {{
      btn.disabled = false;
      btn.textContent = 'Start the day';
      if (d.skipped) {{
        showToast('Skipped: ' + (d.reason || 'cooldown'), 'yellow');
        status.textContent = 'Skipped \u2014 cooldown active';
      }} else if (d.ok) {{
        showToast('Day started! Schedule synced.', 'green');
        status.textContent = 'Done at ' + (d.finished_at || '');
        setTimeout(() => location.reload(), 1500);
      }} else {{
        showToast('Error: ' + JSON.stringify(d), 'red');
        status.textContent = 'Error';
      }}
    }})
    .catch(e => {{
      btn.disabled = false;
      btn.textContent = 'Start the day';
      showToast('Network error', 'red');
      status.textContent = 'Failed';
    }});
}}

function showToast(msg, color) {{
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color === 'green' ? '#166534' : color === 'red' ? '#991b1b' : '#854d0e';
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 4000);
}}
</script>
</body></html>"""
