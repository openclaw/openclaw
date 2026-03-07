"""Notion compliance verification job — runs daily.

Verifies the Notion workspace against template_manifest.yaml and persists
the compliance report. Read-only — no mutations.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.notion_verify")


def run_notion_verify(conn: sqlite3.Connection) -> dict[str, Any]:
    """Execute Notion compliance verification.

    Returns dict with compliance status and issue counts.
    """
    correlation_id = new_id("corr")

    if not settings.NOTION_API_KEY or not settings.NOTION_ROOT_PAGE_ID:
        log.info("notion_verify_skip_no_config")
        return {"ok": True, "skipped": True, "reason": "no_notion_config"}

    state = SystemState(conn)
    audit = AuditWriter(conn)

    try:
        from packages.agencyu.notion.client import NotionClient

        client = NotionClient()
        api = NotionAPI(client)
        verifier = NotionComplianceVerifier(
            notion_api=api,
            conn=conn,
            root_page_id=settings.NOTION_ROOT_PAGE_ID,
        )

        report = verifier.verify()
        verifier.persist_report(report)

        # Update last_verified_at in system_settings
        now = utc_now_iso()
        try:
            conn.execute(
                """INSERT INTO system_settings (key, value, updated_at)
                   VALUES ('last_verified_at', ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                (now, now),
            )
            conn.commit()
        except Exception:
            pass

        audit.write_event(
            action="notion.verify",
            target_type="notion_workspace",
            target_id=settings.NOTION_ROOT_PAGE_ID,
            details={
                "ok": report.ok,
                "total_issues": len(report.issues),
                "critical": report.critical_count,
                "healable": report.healable_count,
                "databases_checked": report.databases_checked,
                "databases_missing": report.databases_missing,
                "manifest_version": report.manifest_version,
            },
            correlation_id=correlation_id,
            result="ok" if report.ok else "failed",
        )

        log.info("notion_verify_complete", extra={
            "ok": report.ok,
            "issues": len(report.issues),
            "correlation_id": correlation_id,
        })

        return {
            "ok": report.ok,
            "total_issues": len(report.issues),
            "critical": report.critical_count,
            "healable": report.healable_count,
            "manifest_version": report.manifest_version,
            "correlation_id": correlation_id,
        }

    except Exception:
        log.warning("notion_verify_error", exc_info=True)
        audit.write_event(
            action="notion.verify",
            target_type="notion_workspace",
            target_id=settings.NOTION_ROOT_PAGE_ID or "unknown",
            details={"error": "verification_failed"},
            correlation_id=correlation_id,
            result="failed",
        )
        return {"ok": False, "error": "verification_failed", "correlation_id": correlation_id}
