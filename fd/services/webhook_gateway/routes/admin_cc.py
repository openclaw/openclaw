"""Command Center aggregator — single endpoint for the local web UI.

Endpoints:
  GET  /admin/cc/panels     — aggregated dashboard data (all panels in one response)
  POST /admin/cc/prompt     — submit a natural language prompt via UIPromptAdapter
  GET  /admin/cc/guide/panels     — all panel help content for info icons
  GET  /admin/cc/guide/walkthrough — walkthrough overlay steps
  GET  /admin/cc/guide/prompt-bar  — prompt bar config + suggestions
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.admin_cc")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


# ── Aggregated panels endpoint ──


@router.get("/panels")
def cc_panels(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Return all Command Center panel data in a single response.

    Aggregates today, health, schedule, and approvals data so the
    web UI can render the full dashboard with one fetch.
    """
    # Today panel data
    today_data: dict[str, Any] = {}
    try:
        from services.webhook_gateway.routes.admin_today import _build_today_data

        today_data = _build_today_data()
    except Exception as exc:
        log.error("cc_panels_today_error", extra={"error": str(exc)})
        today_data = {"error": str(exc)}

    # System health data
    health_data: dict[str, Any] = {}
    try:
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator
        from packages.agencyu.notion.widgets.compliance_verifier import (
            CommandCenterComplianceVerifier,
        )
        from packages.common.cooldown import get_cooldown
        from packages.common.job_runs import get_last_success_ts

        cooldown = get_cooldown(_conn)
        warnings: list[str] = []

        if cooldown.get("active"):
            warnings.append("cooldown_active")

        # Queue depth
        queue_depth: int | None = None
        try:
            row = _conn.execute(
                "SELECT COUNT(*) FROM scheduled_actions WHERE status='pending'"
            ).fetchone()
            queue_depth = int(row[0]) if row else 0
        except Exception:
            queue_depth = None

        # Notion compliance (lightweight — no API calls)
        notion_compliance: dict[str, Any] = {}
        try:
            validator = NotionManifestValidator(_conn)
            compliance = validator.validate()
            notion_compliance = {
                "compliant": compliance.compliant,
                "drift_issue_count": len(compliance.issues),
                "healable": compliance.healable_count,
            }
            if not compliance.compliant:
                warnings.append(f"notion_drift_issues:{len(compliance.issues)}")
        except Exception:
            notion_compliance = {"error": "unavailable"}

        # CC compliance
        cc_compliance: dict[str, Any] = {}
        try:
            cc_verifier = CommandCenterComplianceVerifier(_conn)
            cc_report = cc_verifier.verify()
            cc_compliance = {
                "compliant": cc_report.compliant,
                "summary": cc_report.summary,
            }
            if not cc_report.compliant:
                warnings.append(f"cc_not_compliant:{cc_report.summary}")
        except Exception:
            cc_compliance = {"error": "unavailable"}

        # WebOps last run
        webops_last = get_last_success_ts(_conn, job_name="webops_checks")

        health_data = {
            "warnings": warnings,
            "cooldown": cooldown,
            "queue": {"scheduled_actions_pending": queue_depth},
            "notion_compliance_status": notion_compliance,
            "command_center_compliance": cc_compliance,
            "webops": {"last_success_ts": webops_last},
        }
    except Exception as exc:
        log.error("cc_panels_health_error", extra={"error": str(exc)})
        health_data = {"error": str(exc)}

    # Schedule data
    schedule_data: dict[str, Any] = {}
    try:
        from packages.agencyu.schedule.sync_engine import get_last_sync_run

        jobs = [
            "schedule_pull_gcal",
            "schedule_pull_trello_due",
            "schedule_reconcile",
        ]
        last_runs = {}
        for job in jobs:
            last_runs[job] = get_last_sync_run(_conn, job)

        # Event counts
        total = _conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE status != 'cancelled'"
        ).fetchone()[0]
        by_source = _conn.execute(
            "SELECT source, COUNT(*) as cnt FROM schedule_events "
            "WHERE status != 'cancelled' GROUP BY source"
        ).fetchall()
        conflicts = _conn.execute(
            "SELECT COUNT(*) FROM schedule_events "
            "WHERE conflict_flag=1 AND status != 'cancelled'"
        ).fetchone()[0]

        schedule_data = {
            "last_runs": last_runs,
            "event_counts": {
                "total_active": total,
                "by_source": {r["source"]: r["cnt"] for r in by_source},
                "conflicts": conflicts,
            },
        }
    except Exception as exc:
        log.error("cc_panels_schedule_error", extra={"error": str(exc)})
        schedule_data = {"error": str(exc)}

    # Approvals (pending scheduled actions)
    approvals_data: dict[str, Any] = {}
    try:
        pending_rows = _conn.execute(
            "SELECT id, action_type, description, created_at "
            "FROM scheduled_actions WHERE status='pending' "
            "ORDER BY created_at DESC LIMIT 10"
        ).fetchall()
        items = [
            {
                "id": r["id"],
                "action_type": r["action_type"],
                "description": r["description"],
                "created_at": r["created_at"],
            }
            for r in pending_rows
        ]
        approvals_data = {
            "pending_count": len(items),
            "items": items,
        }
    except Exception:
        # Table may not exist yet — graceful fallback
        approvals_data = {"pending_count": 0, "items": []}

    return {
        "ok": True,
        "today": today_data,
        "health": health_data,
        "schedule": schedule_data,
        "approvals": approvals_data,
        "ts": datetime.now(UTC).isoformat(),
    }


# ── Prompt submission endpoint ──


class PromptRequest(BaseModel):
    text: str
    brand_hint: str | None = None


@router.post("/prompt")
def cc_prompt(
    payload: PromptRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Submit a natural language prompt from the Command Center UI.

    Wraps UIPromptAdapter → OpenClawPromptEngine → EngineResponse.
    """
    try:
        from workspace.prompt_engine.adapters.ui_adapter import UIPromptAdapter
        from workspace.prompt_engine.engine import OpenClawPromptEngine

        engine = OpenClawPromptEngine()
        adapter = UIPromptAdapter(engine)
        response = adapter.handle_prompt(
            user_id="admin",
            text=payload.text,
            brand_hint=payload.brand_hint,
        )
        return adapter.to_json(response)
    except Exception as exc:
        log.error("cc_prompt_error", extra={"error": str(exc)})
        return {
            "ok": False,
            "reply": f"Error processing prompt: {exc}",
            "conversation_id": "ui:admin",
        }


# ── Guide endpoints ──


@router.get("/guide/panels")
def cc_guide_panels(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Return all panel help content for info icons."""
    try:
        from workspace.guide.adapters.ui import get_all_panel_info

        return {"ok": True, "panels": get_all_panel_info()}
    except Exception as exc:
        log.error("cc_guide_panels_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.get("/guide/walkthrough")
def cc_guide_walkthrough(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Return walkthrough overlay steps."""
    try:
        from workspace.guide.adapters.ui import get_walkthrough

        return {"ok": True, "steps": get_walkthrough()}
    except Exception as exc:
        log.error("cc_guide_walkthrough_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.get("/guide/prompt-bar")
def cc_guide_prompt_bar(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Return prompt bar configuration + suggestions."""
    try:
        from workspace.guide.adapters.ui import get_prompt_bar_config

        return {"ok": True, **get_prompt_bar_config()}
    except Exception as exc:
        log.error("cc_guide_prompt_bar_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}
