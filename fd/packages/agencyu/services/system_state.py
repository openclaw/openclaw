"""SystemState: typed key-value access layer over the system_state table.

Provides str/int/bool/JSON getters and setters, canonical key constants,
and a ring-buffer helper for job stop reasons.

Designed to be swappable — v1 uses SQLite; the DB layer can be replaced later.
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.services.system_state")


class SystemState:
    """Typed accessor for system_state key-value table."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    # ─────────────────────────────────────────
    # Core accessors
    # ─────────────────────────────────────────

    def get_str(self, key: str, default: str | None = None) -> str | None:
        try:
            row = self.conn.execute(
                "SELECT value FROM system_state WHERE key=?", (key,)
            ).fetchone()
            if not row:
                return default
            return row[0]
        except Exception:
            return default

    def set_str(self, key: str, value: str) -> None:
        try:
            self.conn.execute(
                """INSERT INTO system_state(key, value, updated_ts)
                   VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts""",
                (key, value, utc_now_iso()),
            )
            self.conn.commit()
        except Exception as exc:
            log.error("system_state_write_failed", extra={"key": key, "error": str(exc)})

    def get_int(self, key: str, default: int | None = None) -> int | None:
        val = self.get_str(key)
        if val is None or val == "":
            return default
        try:
            return int(val)
        except (ValueError, TypeError):
            return default

    def set_int(self, key: str, value: int) -> None:
        self.set_str(key, str(value))

    def get_bool(self, key: str, default: bool = False) -> bool:
        val = self.get_str(key)
        if val is None or val == "":
            return default
        return val.strip().lower() in ("1", "true", "yes", "on")

    def set_bool(self, key: str, value: bool) -> None:
        self.set_str(key, "true" if value else "false")

    def get_json(self, key: str, default: dict[str, Any] | None = None) -> dict[str, Any]:
        val = self.get_str(key)
        if not val:
            return default or {}
        try:
            obj = json.loads(val)
            if isinstance(obj, dict):
                return obj
            return default or {}
        except Exception:
            return default or {}

    def set_json(self, key: str, value: dict[str, Any]) -> None:
        self.set_str(key, json.dumps(value, ensure_ascii=False))

    def get_updated_at(self, key: str) -> str | None:
        try:
            row = self.conn.execute(
                "SELECT updated_ts FROM system_state WHERE key=?", (key,)
            ).fetchone()
            return row[0] if row else None
        except Exception:
            return None


# ─────────────────────────────────────────
# Canonical key constants
# ─────────────────────────────────────────


class SystemKeys:
    """Well-known system_state keys."""

    # Circuit breaker / cooldown
    NOTION_AUDIT_MIRROR_COOLDOWN_UNTIL_EPOCH = "notion_audit_mirror_cooldown_until_epoch"
    NOTION_AUDIT_MIRROR_LAST_TRIP_REASON = "notion_audit_mirror_last_trip_reason"

    # Reconcile timestamps
    LAST_RECONCILE_SUCCESS_AT = "last_reconcile_success_at"
    LAST_RECONCILE_ATTEMPT_AT = "last_reconcile_attempt_at"

    # Job stop reasons ring buffer (JSON)
    RECENT_JOB_STOPS_JSON = "recent_job_stops_json"

    # Queue depth snapshot
    QUEUE_DEPTH_SCHEDULED_ACTIONS = "queue_depth_scheduled_actions"


# ─────────────────────────────────────────
# Ring buffer helper for job stop reasons
# ─────────────────────────────────────────


def push_recent_stop(
    state: SystemState,
    item: dict[str, Any],
    max_items: int = 50,
) -> None:
    """Push a job stop reason into the ring buffer.

    Args:
        state: SystemState accessor.
        item: Dict with ts, job, reason, correlation_id, etc.
        max_items: Max entries to retain.
    """
    buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON, default={"items": []})
    items = buf.get("items", [])
    items.insert(0, item)
    buf["items"] = items[:max_items]
    state.set_json(SystemKeys.RECENT_JOB_STOPS_JSON, buf)
