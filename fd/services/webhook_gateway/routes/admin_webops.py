"""Admin WebOps endpoints — run checks, view status, fix now, repair plans.

POST /admin/webops/run_checks              — Run all provider checks + persist + incidents
GET  /admin/webops/status                  — Last results + R/Y/G dashboard + history
POST /admin/webops/fix_now                 — Safe fixes + repair plan for RED sites
GET  /admin/webops/repair_plans            — List repair plans
POST /admin/webops/repair_plans/approve    — Approve a pending plan
POST /admin/webops/repair_plans/reject     — Reject a pending plan
GET  /admin/webops/drift                   — Live drift detection + proposals
POST /admin/webops/train_stack             — Build deterministic Stack Map

All endpoints require admin ops token.
"""
from __future__ import annotations

import time
from typing import Any

import yaml
from fastapi import APIRouter, Depends, Query

from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.ids import new_id
from packages.common.job_runs import record_job_run
from packages.common.logging import get_logger
from packages.webops.drift.detector import run_all_checks
from packages.webops.drift.healer import propose_fixes
from packages.webops.incidents import close_missing_incidents, get_open_incidents, upsert_incidents
from packages.webops.learning.stack_trainer import run_stack_trainer
from packages.webops.providers.cloudflare import CloudflareClient
from packages.webops.providers.vercel import VercelClient
from packages.webops.rate_limit import RateLimiter
from packages.webops.repairs.policy import classify_repairs
from packages.webops.repairs.safe_fixes import run_cloudflare_purge, run_vercel_redeploy
from packages.webops.repairs.storage import (
    approve_repair_plan,
    create_repair_plan,
    get_pending_plan_for_site,
    get_repair_plans,
    log_fix_action,
    reject_repair_plan,
)
from packages.webops.report.daily_web_report import build_daily_report
from packages.webops.scoring import score_sites
from packages.webops.storage import get_latest_run, get_run_history, save_webops_run
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.admin_webops")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


def _load_site_registry() -> dict[str, dict[str, Any]]:
    """Load sites.yaml into a dict keyed by site_key."""
    try:
        with open("config/sites.yaml") as f:
            data = yaml.safe_load(f) or {}
        return {s["site_key"]: s for s in data.get("sites", [])}
    except Exception:
        return {}


def _make_cloudflare_client() -> CloudflareClient | None:
    token = settings.CLOUDFLARE_API_TOKEN
    if not token:
        return None
    return CloudflareClient(api_token=token, limiter=RateLimiter(rpm=60))


def _make_vercel_client() -> VercelClient | None:
    token = settings.VERCEL_API_TOKEN
    if not token:
        return None
    return VercelClient(api_token=token, limiter=RateLimiter(rpm=60))


# ── Recheck config defaults ───────────────────────────────
_FIX_RECHECK_DELAY_SECONDS = 12
_FIX_RECHECK_MAX_DELAY_SECONDS = 30


def _run_checks_core(cid: str | None = None) -> dict[str, Any]:
    """Core run_checks logic — shared by the endpoint and fix_now recheck.

    Runs all provider checks, scores, persists, manages incidents.
    Returns the full response dict (same shape as the endpoint).
    """
    if cid is None:
        cid = new_id("webops_checks")

    drift_results = run_all_checks()
    proposals = propose_fixes(drift_results)
    report = build_daily_report(drift_results)

    scored = score_sites(drift_results)

    inc_upserted = upsert_incidents(_conn, scored["incidents"])
    current_fps = [i["fingerprint"] for i in scored["incidents"]]
    inc_closed = close_missing_incidents(_conn, open_fingerprints=current_fps)

    run_id = save_webops_run(_conn, correlation_id=cid, payload=drift_results)

    failed_count = len(drift_results.get("failed", []))
    record_job_run(
        _conn,
        job_name="webops_checks",
        status="ok" if drift_results.get("ok") else "warning",
        detail=(
            f"sites={drift_results.get('sites_checked', 0)} "
            f"failed={failed_count} "
            f"planned={len(drift_results.get('planned_coverage', []))}"
        ),
    )

    log.info("webops_checks_done", extra={
        "correlation_id": cid,
        "ok": drift_results.get("ok"),
        "sites_checked": drift_results.get("sites_checked"),
        "failed": failed_count,
        "run_id": run_id,
    })

    return {
        "ok": drift_results.get("ok", False),
        "correlation_id": cid,
        "timestamp": drift_results.get("timestamp"),
        "sites_checked": drift_results.get("sites_checked", 0),
        "checks": drift_results.get("checks", []),
        "failed": drift_results.get("failed", []),
        "planned_coverage": drift_results.get("planned_coverage", []),
        "proposals": proposals,
        "warnings": drift_results.get("warnings", []),
        "report": report,
        "scoring": scored["sites"],
        "persisted": {
            "run_id": run_id,
            "incidents_created": inc_upserted["created"],
            "incidents_updated": inc_upserted["updated"],
            "incidents_closed": inc_closed,
        },
    }


@router.post("/admin/webops/run_checks")
def webops_run_checks(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run all WebOps provider checks, persist results, manage incidents."""
    cid = new_id("webops_checks")
    try:
        return _run_checks_core(cid)
    except Exception as exc:
        log.error("webops_checks_error", extra={"error": str(exc), "correlation_id": cid})
        return {"ok": False, "correlation_id": cid, "error": str(exc)}


@router.get("/admin/webops/status")
def webops_status(
    _: None = Depends(require_admin_ops_token),
    limit: int = Query(20, description="Max history entries"),
) -> dict[str, Any]:
    """Kid-simple status: overall RED/YELLOW/GREEN + per-site traffic lights.

    Returns:
    - overall: "green" | "yellow" | "red" | "unknown"
    - sites[]: per-site status with top failures/warnings
    - open_incidents[]: current open incidents
    - latest: last run metadata
    - history[]: last N run summaries
    """
    latest = get_latest_run(_conn)
    history = get_run_history(_conn, limit=limit)

    if not latest:
        return {
            "ok": True,
            "overall": "unknown",
            "message": "No WebOps runs yet. Run checks first.",
            "sites": [],
            "open_incidents": [],
            "history": history,
        }

    payload = latest["payload"]
    scored = score_sites(payload)

    open_inc = get_open_incidents(_conn)

    # Overall color
    overall = "green"
    if any(s["status"] == "red" for s in scored["sites"]):
        overall = "red"
    elif any(s["status"] == "yellow" for s in scored["sites"]):
        overall = "yellow"

    # Enrich each site with fix_now availability + pending plan
    for s in scored["sites"]:
        if s["status"] == "red":
            s["can_fix_now"] = True
            pending = get_pending_plan_for_site(_conn, site_key=s["site_key"])
            s["pending_repair_plan_id"] = pending["plan_id"] if pending else None
        else:
            s["can_fix_now"] = False
            s["pending_repair_plan_id"] = None

    return {
        "ok": True,
        "overall": overall,
        "latest": {
            "run_id": latest["run_id"],
            "finished_at_utc": latest["finished_at_utc"],
            "correlation_id": latest["correlation_id"],
        },
        "sites": scored["sites"],
        "open_incidents": open_inc,
        "history": history,
    }


def _site_snapshot(site_score: dict[str, Any]) -> dict[str, Any]:
    """Compact site snapshot for before/after summaries."""
    return {
        "site_key": site_score["site_key"],
        "status": site_score["status"],
        "failures": site_score.get("failures", [])[:5],
        "warnings": site_score.get("warnings", [])[:5],
    }


@router.post("/admin/webops/fix_now")
def webops_fix_now(
    _: None = Depends(require_admin_ops_token),
    site_key: str = Query(..., description="Site key to fix"),
    recheck: bool = Query(False, description="Re-run checks after fix"),  # noqa: FBT001
    delay_seconds: int = Query(
        _FIX_RECHECK_DELAY_SECONDS,
        description="Seconds to wait before recheck",
    ),
) -> dict[str, Any]:
    """Run safe fixes for a RED site + optional recheck.

    recheck=false (default): runs safe fixes, generates risky plan, returns.
    recheck=true: runs safe fixes, waits delay_seconds, re-runs full checks,
    returns a compact before/after transition ("RED -> GREEN").
    """
    cid = new_id("webops_fix")

    # Clamp delay
    delay_seconds = max(0, min(delay_seconds, _FIX_RECHECK_MAX_DELAY_SECONDS))

    # Must have a latest run
    latest_before = get_latest_run(_conn)
    if not latest_before:
        return {"ok": False, "correlation_id": cid, "error": "no_webops_runs"}

    payload_before = latest_before["payload"]
    scored_before = score_sites(payload_before)
    site_before = next(
        (s for s in scored_before["sites"] if s["site_key"] == site_key), None,
    )
    if not site_before:
        return {"ok": False, "correlation_id": cid, "error": "unknown_site_key"}

    if site_before["status"] != "red":
        return {
            "ok": True,
            "correlation_id": cid,
            "message": "Site is not RED; no fix_now needed.",
            "before": _site_snapshot(site_before),
        }

    # Classify failures into safe vs risky
    repairs = classify_repairs(site_before, payload_before)
    safe_actions = repairs["safe"]
    risky_steps = repairs["risky_plan"]

    # Load site config for provider params
    registry = _load_site_registry()
    site_cfg = registry.get(site_key, {})

    # Execute safe fixes
    safe_results: list[dict[str, Any]] = []
    safe_ok = True

    for a in safe_actions:
        if a["action"] == "cloudflare_purge_cache":
            cf = _make_cloudflare_client()
            if not cf:
                safe_results.append({"action": a["action"], "ok": False, "error": "no_cloudflare_token"})
                safe_ok = False
                continue
            zone_name = site_cfg.get("cloudflare", {}).get("zone_name", "")
            urls = site_cfg.get("urls")
            r = run_cloudflare_purge(cf, zone_name=zone_name, urls=urls, purge_everything=False)
            safe_results.append({"action": a["action"], "ok": r.get("ok", False), "result": r})
            safe_ok = safe_ok and bool(r.get("ok"))

        elif a["action"] == "vercel_redeploy_latest":
            vc = _make_vercel_client()
            if not vc:
                safe_results.append({"action": a["action"], "ok": False, "error": "no_vercel_token"})
                safe_ok = False
                continue
            project_name = site_cfg.get("vercel", {}).get("project_name", "")
            r = run_vercel_redeploy(vc, project_name=project_name)
            safe_results.append({"action": a["action"], "ok": r.get("ok", False), "result": r})
            safe_ok = safe_ok and bool(r.get("ok"))

    log_fix_action(
        _conn,
        site_key=site_key,
        correlation_id=cid,
        action_type="safe_fix",
        ok=safe_ok,
        details={"safe_results": safe_results},
    )

    # Generate repair plan for risky items
    plan_id = None
    if risky_steps:
        risk_level = "high" if any(
            step["action"] in ("stripe_create_or_update_webhook", "webflow_publish_site")
            for step in risky_steps
        ) else "medium"
        plan_obj = {
            "site_key": site_key,
            "risk_level": risk_level,
            "steps": risky_steps,
            "verification": [
                {"summary": "Re-run /admin/webops/run_checks and confirm the site returns GREEN."},
            ],
            "rollback": [
                {"summary": "Rollback per step; do not apply multiple risky steps without re-check."},
            ],
        }
        plan_id = create_repair_plan(
            _conn, site_key=site_key, risk_level=risk_level, plan=plan_obj,
        )
        log_fix_action(
            _conn,
            site_key=site_key,
            correlation_id=cid,
            action_type="plan_generated",
            ok=True,
            details={"plan_id": plan_id},
        )

    log.info("webops_fix_now_done", extra={
        "correlation_id": cid,
        "site_key": site_key,
        "safe_ok": safe_ok,
        "plan_id": plan_id,
        "recheck": recheck,
    })

    response: dict[str, Any] = {
        "ok": True,
        "correlation_id": cid,
        "site_key": site_key,
        "before": _site_snapshot(site_before),
        "safe_results": safe_results,
        "repair_plan_created": bool(plan_id),
        "repair_plan_id": plan_id,
        "note": "Safe fixes executed. Risky repairs require plan approval." if plan_id else "Safe fixes executed.",
    }

    # ── Optional recheck ─────────────────────────────────
    if recheck:
        if delay_seconds > 0:
            time.sleep(delay_seconds)

        recheck_cid = new_id("webops_recheck")
        try:
            _run_checks_core(recheck_cid)
        except Exception as exc:
            response["recheck"] = {"attempted": True, "ok": False, "error": str(exc)}
            return response

        latest_after = get_latest_run(_conn)
        if not latest_after:
            response["recheck"] = {"attempted": True, "ok": False, "error": "no_recheck_payload"}
            return response

        scored_after = score_sites(latest_after["payload"])
        site_after = next(
            (s for s in scored_after["sites"] if s["site_key"] == site_key), None,
        )
        after_status = site_after["status"] if site_after else "unknown"
        response["recheck"] = {
            "attempted": True,
            "ok": True,
            "delay_seconds": delay_seconds,
            "run_id": latest_after["run_id"],
            "finished_at_utc": latest_after["finished_at_utc"],
            "after": _site_snapshot(site_after) if site_after else {},
            "transition": f"{site_before['status'].upper()} -> {after_status.upper()}",
        }

    return response


@router.get("/admin/webops/repair_plans")
def webops_repair_plans(
    _: None = Depends(require_admin_ops_token),
    site_key: str | None = Query(None, description="Filter by site_key"),
    status: str | None = Query(None, description="Filter by status"),
    limit: int = Query(50, description="Max plans to return"),
) -> dict[str, Any]:
    """List repair plans, optionally filtered by site and status."""
    plans = get_repair_plans(_conn, site_key=site_key, status=status, limit=limit)
    return {"ok": True, "plans": plans, "count": len(plans)}


@router.post("/admin/webops/repair_plans/approve")
def webops_approve_plan(
    _: None = Depends(require_admin_ops_token),
    plan_id: int = Query(..., description="Plan ID to approve"),  # noqa: B008
) -> dict[str, Any]:
    """Approve a pending repair plan. Does NOT apply it yet."""
    updated = approve_repair_plan(_conn, plan_id=plan_id)
    if not updated:
        return {"ok": False, "error": "plan_not_found_or_not_pending", "plan_id": plan_id}
    return {"ok": True, "plan_id": plan_id, "status": "approved"}


@router.post("/admin/webops/repair_plans/reject")
def webops_reject_plan(
    _: None = Depends(require_admin_ops_token),
    plan_id: int = Query(..., description="Plan ID to reject"),  # noqa: B008
) -> dict[str, Any]:
    """Reject a pending repair plan."""
    updated = reject_repair_plan(_conn, plan_id=plan_id)
    if not updated:
        return {"ok": False, "error": "plan_not_found_or_not_pending", "plan_id": plan_id}
    return {"ok": True, "plan_id": plan_id, "status": "rejected"}


@router.get("/admin/webops/drift")
def webops_drift(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run drift detection and return proposals (read-only)."""
    cid = new_id("webops_drift")
    try:
        drift_results = run_all_checks()
        proposals = propose_fixes(drift_results)
        return {
            "ok": True,
            "correlation_id": cid,
            "drift": drift_results,
            "proposals": proposals,
        }
    except Exception as exc:
        log.error("webops_drift_error", extra={"error": str(exc), "correlation_id": cid})
        return {"ok": False, "correlation_id": cid, "error": str(exc)}


@router.post("/admin/webops/train_stack")
def webops_train_stack(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run the stack trainer — build a deterministic Stack Map from config."""
    cid = new_id("webops_train")
    try:
        stack_map = run_stack_trainer()

        log.info("webops_train_done", extra={
            "correlation_id": cid,
            "sites": len(stack_map.get("sites", [])),
            "tools": len(stack_map.get("tools", {})),
        })

        return {
            "ok": True,
            "correlation_id": cid,
            "stack_map": stack_map,
        }

    except Exception as exc:
        log.error("webops_train_error", extra={"error": str(exc), "correlation_id": cid})
        return {"ok": False, "correlation_id": cid, "error": str(exc)}
