"""Dual-write audit writer — SQLite (canonical) + Notion (visibility plane).

Every schema heal, portal heal, mapping heal, and write operation is logged to
both the local SQLite audit_logs table and (optionally) the Notion System Audit
Log database for operator visibility.

Design:
- SQLite writes are synchronous and authoritative
- Notion writes are best-effort (never raise on failure)
- Payload is truncated to 1900 chars for Notion rich_text limits
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.audit_writer")


class AuditWriter:
    """Dual-write audit to SQLite and optional Notion System Audit Log DB."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: Any | None = None,
        notion_audit_db_id: str | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.notion_audit_db_id = notion_audit_db_id

    def write_event(
        self,
        *,
        action: str,
        target_type: str,
        target_id: str,
        details: dict[str, Any] | None = None,
        correlation_id: str = "",
        system: str = "openclaw",
        result: str = "ok",
        stop_reason: str = "",
    ) -> str:
        """Write an audit event to SQLite and optionally Notion.

        Returns the audit entry ID.
        """
        now = utc_now_iso()
        ts = int(time.time())
        audit_id = new_id("aud")
        payload_json = json.dumps(details or {}, ensure_ascii=False)

        # 1. SQLite (authoritative)
        try:
            self.conn.execute(
                """INSERT INTO system_audit_log
                   (id, correlation_id, system, action, target, result,
                    details, stop_reason, timestamp, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    audit_id,
                    correlation_id,
                    system,
                    action,
                    f"{target_type}:{target_id}",
                    result,
                    payload_json,
                    stop_reason,
                    now,
                    now,
                ),
            )
            self.conn.commit()
        except Exception:
            log.warning("audit_sqlite_write_error", exc_info=True)

        # 2. Notion (best-effort visibility)
        if self.notion and self.notion_audit_db_id:
            try:
                props: dict[str, Any] = {
                    "name": {
                        "title": [{"text": {"content": action}}],
                    },
                    "ts": {"date": {"start": now}},
                    "correlation_id": {
                        "rich_text": [{"text": {"content": correlation_id or ""}}],
                    },
                    "system": {"select": {"name": system}},
                    "action": {
                        "rich_text": [{"text": {"content": action}}],
                    },
                    "target": {
                        "rich_text": [{"text": {"content": f"{target_type}:{target_id}"}}],
                    },
                    "result": {"select": {"name": result}},
                    "payload_json": {
                        "rich_text": [{"text": {"content": payload_json[:1900]}}],
                    },
                    "system_managed": {"checkbox": True},
                }
                if stop_reason:
                    props["stop_reason"] = {
                        "rich_text": [{"text": {"content": stop_reason}}],
                    }

                self.notion.create_page(
                    parent={"type": "database_id", "database_id": self.notion_audit_db_id},
                    properties=props,
                )
            except Exception:
                log.debug("audit_notion_write_skipped", exc_info=True)

        return audit_id

    def write_batch(
        self, events: list[dict[str, Any]], correlation_id: str = ""
    ) -> list[str]:
        """Write multiple audit events. Returns list of audit IDs."""
        ids = []
        for evt in events:
            aid = self.write_event(
                action=evt.get("action", "unknown"),
                target_type=evt.get("target_type", "unknown"),
                target_id=evt.get("target_id", "unknown"),
                details=evt.get("details"),
                correlation_id=correlation_id or evt.get("correlation_id", ""),
                system=evt.get("system", "openclaw"),
                result=evt.get("result", "ok"),
                stop_reason=evt.get("stop_reason", ""),
            )
            ids.append(aid)
        return ids
