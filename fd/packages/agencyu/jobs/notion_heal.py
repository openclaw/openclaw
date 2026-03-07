"""Notion drift healing job — runs weekly during maintenance window.

Detects drift issues and applies additive fixes (missing properties,
missing select options). Never deletes properties or changes types.

Respects write_lock, DRY_RUN, NOTION_WRITE_ENABLED, and KILL_SWITCH.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.system_state import SystemState
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.notion_heal")


def run_notion_heal(conn: sqlite3.Connection, force: bool = False) -> dict[str, Any]:
    """Execute Notion drift healing.

    Args:
        conn: SQLite connection.
        force: If True, skip write_lock check (emergency override).

    Returns dict with healing results.
    """
    correlation_id = new_id("corr")

    if not settings.NOTION_API_KEY or not settings.NOTION_ROOT_PAGE_ID:
        log.info("notion_heal_skip_no_config")
        return {"ok": True, "skipped": True, "reason": "no_notion_config"}

    state = SystemState(conn)
    audit = AuditWriter(conn)

    # Safety checks
    if state.cooldown_active():
        return {"ok": False, "blocked": True, "reason": "cooldown_active"}

    if not force and state.write_lock_active():
        return {"ok": False, "blocked": True, "reason": "write_lock_active"}

    try:
        from packages.agencyu.notion.client import NotionClient
        from packages.agencyu.notion.drift_healer import DriftHealer
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        client = NotionClient()
        validator = NotionManifestValidator(conn, client)
        healer = DriftHealer(conn, client, validator)

        # Simulate first
        plan = healer.simulate()
        log.info("notion_heal_plan", extra={
            "actions": len(plan.actions),
            "ok_to_apply": plan.ok_to_apply,
            "blocked_reasons": plan.blocked_reasons,
        })

        if not plan.actions:
            audit.write_event(
                action="notion.heal",
                target_type="notion_workspace",
                target_id=settings.NOTION_ROOT_PAGE_ID,
                details={"actions": 0, "result": "no_drift"},
                correlation_id=correlation_id,
                result="ok",
            )
            return {"ok": True, "actions": 0, "result": "no_drift", "correlation_id": correlation_id}

        # Apply
        applied_plan = healer.apply(correlation_id=correlation_id)

        audit.write_event(
            action="notion.heal",
            target_type="notion_workspace",
            target_id=settings.NOTION_ROOT_PAGE_ID,
            details={
                "actions": len(applied_plan.actions),
                "ok_to_apply": applied_plan.ok_to_apply,
                "blocked_reasons": applied_plan.blocked_reasons,
            },
            correlation_id=correlation_id,
            result="ok" if applied_plan.ok_to_apply else "blocked",
        )

        return {
            "ok": True,
            "actions": len(applied_plan.actions),
            "ok_to_apply": applied_plan.ok_to_apply,
            "blocked_reasons": applied_plan.blocked_reasons,
            "correlation_id": correlation_id,
        }

    except Exception:
        log.warning("notion_heal_error", exc_info=True)
        audit.write_event(
            action="notion.heal",
            target_type="notion_workspace",
            target_id=settings.NOTION_ROOT_PAGE_ID or "unknown",
            details={"error": "heal_failed"},
            correlation_id=correlation_id,
            result="failed",
        )
        return {"ok": False, "error": "heal_failed", "correlation_id": correlation_id}
