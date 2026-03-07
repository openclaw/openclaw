"""Admin Schedule Endpoints — sync control, status, and reconciliation.

Endpoints:
  GET  /admin/schedule/status     — last run + history
  POST /admin/schedule/run_sync   — trigger sync (safe_mode by default)
  POST /admin/schedule/reconcile  — run drift healer
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Query

from packages.agencyu.schedule.repo import ScheduleRepo
from packages.agencyu.schedule.sync_engine import (
    finish_sync_run,
    get_last_sync_run,
    get_sync_history,
    reconcile_schedule,
    record_sync_run,
    run_daily_sync,
)
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.admin_schedule")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.get("/status")
def schedule_status(
    _: None = Depends(require_admin_ops_token),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """Return schedule sync status: last run per job + recent history."""
    jobs = ["schedule_pull_gcal", "schedule_pull_trello_due", "schedule_reconcile", "schedule_daily_sync"]
    last_runs = {}
    for job in jobs:
        run = get_last_sync_run(_conn, job)
        last_runs[job] = run

    # Event counts
    try:
        total = _conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE status != 'cancelled'"
        ).fetchone()[0]
        by_source = _conn.execute(
            "SELECT source, COUNT(*) as cnt FROM schedule_events WHERE status != 'cancelled' GROUP BY source"
        ).fetchall()
        conflicts = _conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE conflict_flag=1 AND status != 'cancelled'"
        ).fetchone()[0]
    except Exception:
        total = 0
        by_source = []
        conflicts = 0

    return {
        "ok": True,
        "last_runs": last_runs,
        "history": get_sync_history(_conn, limit),
        "event_counts": {
            "total_active": total,
            "by_source": {r["source"]: r["cnt"] for r in by_source},
            "conflicts": conflicts,
        },
    }


@router.post("/run_sync")
def schedule_run_sync(
    _: None = Depends(require_admin_ops_token),
    safe: bool = Query(True, description="Safe mode — simulate without writing"),
    source: str = Query("all", description="Source to sync: all, gcal, trello"),
    brand: str = Query("all", description="Brand to sync: all, fulldigital, cutmv"),
) -> dict[str, Any]:
    """Trigger schedule sync from external sources.

    safe=1: returns planned operations without writing.
    safe=0: applies the sync.
    """
    brands = ["fulldigital", "cutmv"] if brand == "all" else [brand]
    results: dict[str, Any] = {"safe_mode": safe, "source": source, "brand": brand}

    # Job 1: Google Calendar sync
    if source in ("all", "gcal"):
        gcal_results: dict[str, Any] = {}
        calendar_ids = json.loads(settings.GCAL_CALENDAR_IDS_JSON)

        if not settings.GOOGLE_SERVICE_ACCOUNT_KEY_PATH:
            gcal_results = {"skipped": True, "reason": "GOOGLE_SERVICE_ACCOUNT_KEY_PATH not configured"}
        elif safe:
            gcal_results = {
                "dry_run": True,
                "calendar_ids": calendar_ids,
                "brands": brands,
                "write_enabled": settings.GCAL_WRITE_ENABLED,
            }
        else:
            from packages.agencyu.schedule.gcal_provider import GCalProvider, sync_gcal_to_schedule

            run_id = record_sync_run(_conn, "schedule_pull_gcal", "gcal")
            total_synced = 0
            total_errors = 0
            total_removed = 0

            try:
                provider = GCalProvider(
                    service_account_key=settings.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
                    impersonate_email=settings.GOOGLE_IMPERSONATE_EMAIL,
                    calendar_ids=calendar_ids,
                    write_enabled=settings.GCAL_WRITE_ENABLED,
                )
                repo = ScheduleRepo(_conn)
                for b in brands:
                    result = sync_gcal_to_schedule(
                        provider, repo, b,
                        past_days=settings.SCHEDULE_SYNC_WINDOW_PAST_DAYS,
                        future_days=settings.SCHEDULE_SYNC_WINDOW_FUTURE_DAYS,
                    )
                    total_synced += result.get("synced", 0)
                    total_errors += result.get("errors", 0)
                    total_removed += result.get("removed", 0)
                    gcal_results[b] = result

                finish_sync_run(
                    _conn, run_id,
                    status="success" if total_errors == 0 else "error",
                    events_synced=total_synced,
                    events_removed=total_removed,
                    errors=total_errors,
                )
            except Exception as exc:
                finish_sync_run(_conn, run_id, status="error", details={"error": str(exc)})
                gcal_results["error"] = str(exc)

        results["gcal"] = gcal_results

    # Job 2: Trello due date sync
    if source in ("all", "trello"):
        trello_results: dict[str, Any] = {}

        if not settings.TRELLO_KEY or not settings.TRELLO_TOKEN:
            trello_results = {"skipped": True, "reason": "TRELLO_KEY/TOKEN not configured"}
        elif safe:
            trello_results = {"dry_run": True, "brands": brands}
        else:
            from packages.agencyu.schedule.trello_due_sync import sync_board_due_dates
            from packages.integrations.trello.client import TrelloClient

            run_id = record_sync_run(_conn, "schedule_pull_trello_due", "trello")
            total_synced = 0
            total_errors = 0
            total_removed = 0

            try:
                trello = TrelloClient()
                repo = ScheduleRepo(_conn)

                # Use internal board for FD brand
                board_id = settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID
                if board_id:
                    result = sync_board_due_dates(trello, repo, board_id, "fulldigital")
                    total_synced += result.get("synced", 0)
                    total_errors += result.get("errors", 0)
                    total_removed += result.get("removed", 0)
                    trello_results["fulldigital"] = result

                finish_sync_run(
                    _conn, run_id,
                    status="success" if total_errors == 0 else "error",
                    events_synced=total_synced,
                    events_removed=total_removed,
                    errors=total_errors,
                )
            except Exception as exc:
                finish_sync_run(_conn, run_id, status="error", details={"error": str(exc)})
                trello_results["error"] = str(exc)

        results["trello"] = trello_results

    # Job 3: Build daily plans (always runs after source sync)
    if not safe:
        run_id = record_sync_run(_conn, "schedule_daily_sync")
        try:
            daily_result = run_daily_sync(_conn, brands)
            finish_sync_run(
                _conn, run_id,
                status="success",
                details=daily_result,
            )
            results["daily_sync"] = daily_result
        except Exception as exc:
            finish_sync_run(_conn, run_id, status="error", details={"error": str(exc)})
            results["daily_sync"] = {"error": str(exc)}

    return {"ok": True, **results}


@router.post("/reconcile")
def schedule_reconcile(
    _: None = Depends(require_admin_ops_token),
    safe: bool = Query(True, description="Safe mode — simulate without writing"),
) -> dict[str, Any]:
    """Run schedule drift healer / reconciliation.

    Removes stale Notion mirror rows, clears invalid conflict flags.
    """
    run_id = record_sync_run(_conn, "schedule_reconcile")
    try:
        result = reconcile_schedule(_conn, safe_mode=safe)
        finish_sync_run(
            _conn, run_id,
            status="success",
            events_removed=result.get("stale_cleared", 0),
            details=result,
        )
        return {"ok": True, **result}
    except Exception as exc:
        finish_sync_run(_conn, run_id, status="error", details={"error": str(exc)})
        return {"ok": False, "error": str(exc)}
