"""Job: Mirror audit logs from SQLite to Notion System Audit Log DB.

Instantiates NotionAPI and NotionAuditWriter, runs the batch mirror job.
Safe by default — simulates unless write flags are explicitly enabled.
Reports circuit breaker status in response.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.services.audit import AuditLogger
from packages.agencyu.services.notion_audit_writer import (
    NotionAuditWriter,
    NotionAuditWriterConfig,
)
from packages.agencyu.services.system_state import SystemState, SystemKeys, push_recent_stop
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.mirror_audit_logs")


def run_audit_mirror_job(
    conn: sqlite3.Connection,
    correlation_id: str | None = None,
    system_audit_log_db_id: str | None = None,
    safe_mode: bool | None = None,
    notion_write_enabled: bool | None = None,
    notion_write_lock: bool | None = None,
) -> dict[str, Any]:
    """Run the audit log mirroring job.

    Args:
        conn: Active SQLite connection.
        correlation_id: Optional correlation ID for this job run.
        system_audit_log_db_id: Notion DB ID override (resolved from bindings if not provided).
        safe_mode: Override SAFE_MODE setting.
        notion_write_enabled: Override NOTION_WRITE_ENABLED setting.
        notion_write_lock: Override NOTION_WRITE_LOCK setting.

    Returns:
        Summary dict with written/skipped/error counts and circuit breaker status.
    """
    corr_id = correlation_id or new_id("corr")

    # Build NotionAPI
    notion_client = NotionClient()
    notion_api = NotionAPI(notion_client)

    # Build config with explicit overrides or settings defaults
    cfg = NotionAuditWriterConfig(
        system_audit_log_db_id=system_audit_log_db_id or "",
        safe_mode=safe_mode if safe_mode is not None else getattr(settings, "SAFE_MODE", True),
        notion_write_enabled=notion_write_enabled if notion_write_enabled is not None else getattr(settings, "NOTION_WRITE_ENABLED", False),
        notion_write_lock=notion_write_lock if notion_write_lock is not None else getattr(settings, "NOTION_WRITE_LOCK", True),
    )

    writer = NotionAuditWriter(conn, notion_api, cfg=cfg)
    result = writer.run(correlation_id=corr_id)

    # Record job run in audit_logs
    audit = AuditLogger(conn)
    audit.log(
        correlation_id=corr_id,
        system="openclaw",
        action="notion.mirror_audit_logs",
        result="ok" if result.get("ok") else "failed",
        target="system_audit_log",
        payload={
            "written": result.get("written", 0),
            "skipped_existing": result.get("skipped_existing", 0),
            "candidate_count": result.get("candidate_count", 0),
            "simulate": result.get("simulate", False),
            "warnings": result.get("warnings", []),
        },
    )

    # Push job stop reasons if blocked or errored
    warnings = result.get("warnings", [])
    blocked_reason = result.get("blocked_reason", "")
    if warnings or blocked_reason:
        try:
            state = SystemState(conn)
            push_recent_stop(state, {
                "ts": utc_now_iso(),
                "job": "mirror_audit_logs_to_notion",
                "reason": blocked_reason or "; ".join(warnings),
                "correlation_id": corr_id,
                "simulate": result.get("simulate", False),
            })
        except Exception:
            pass  # non-critical

    log.info("audit_mirror_job_complete", extra={
        "written": result.get("written", 0),
        "simulate": result.get("simulate", False),
        "warnings": warnings,
    })

    return result
