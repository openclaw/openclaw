"""Audit logger — records system actions to audit_logs table.

Every significant system action (drift verify, heal, reconcile, backup,
portal compliance, circuit breaker) is recorded here for CEO-level
traceability and debugging.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.services.audit")


class AuditLogger:
    """Logs system actions to the audit_logs SQLite table.

    Usage::
        audit = AuditLogger(conn)
        audit.log(
            correlation_id="corr_abc123",
            system="notion",
            action="heal",
            result="ok",
            target="db:clients",
            payload={"healed_count": 3},
        )
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def log(
        self,
        correlation_id: str,
        system: str,
        action: str,
        result: str,
        target: str | None = None,
        stop_reason: str | None = None,
        payload: dict[str, Any] | None = None,
        notes: str | None = None,
    ) -> str:
        """Record an audit entry. Returns the audit log ID."""
        now = utc_now_iso()
        payload_json = json.dumps(payload, ensure_ascii=False) if payload else None
        audit_id = new_id("aud")
        try:
            self.conn.execute(
                """INSERT INTO audit_logs
                   (id, ts, correlation_id, system, action, target, result,
                    stop_reason, payload_json, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (audit_id, now, correlation_id, system, action, target,
                 result, stop_reason, payload_json, notes),
            )
            self.conn.commit()
        except Exception as exc:
            log.error("audit_log_write_failed", extra={"error": str(exc)})
        return audit_id

    def get_recent(
        self,
        limit: int = 50,
        system: str | None = None,
        result: str | None = None,
    ) -> list[dict[str, Any]]:
        """Retrieve recent audit entries with optional filters."""
        conditions: list[str] = []
        params: list[Any] = []

        if system:
            conditions.append("system=?")
            params.append(system)
        if result:
            conditions.append("result=?")
            params.append(result)

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        params.append(limit)

        rows = self.conn.execute(
            f"SELECT * FROM audit_logs{where} ORDER BY ts DESC LIMIT ?",  # noqa: S608
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def get_by_correlation(self, correlation_id: str) -> list[dict[str, Any]]:
        """Get all audit entries for a correlation ID."""
        rows = self.conn.execute(
            "SELECT * FROM audit_logs WHERE correlation_id=? ORDER BY ts ASC",
            (correlation_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_failures(self, limit: int = 20) -> list[dict[str, Any]]:
        """Get recent failed actions."""
        return self.get_recent(limit=limit, result="failed")
