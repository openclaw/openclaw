"""Centralized system state for Notion + other subsystems.

Reads cooldown status, queue depth, recent job stop reasons, and last
reconcile timestamps. Provides pruning for bounded state storage.

Uses system_state table (key-value) and scheduled_actions table.
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.notion.system_state")


@dataclass
class MutationGuardDecision:
    """Result of a mutation guard check.

    Tells callers whether mutations are allowed and why.
    """

    allow_mutations: bool
    safe_mode: bool
    reason: str
    write_lock: bool
    cooldown_active: bool


class SystemState:
    """Centralized state accessor for Notion compliance, drift healing, and jobs.

    Reads:
    - Cooldown status (from system_state table)
    - Queue depth (from scheduled_actions table)
    - Recent job stop reasons (bounded list in system_state)
    - Last successful reconcile timestamps
    - System settings (write_lock, template_version, etc.)
    """

    def __init__(self, conn: sqlite3.Connection, max_recent_stops: int = 200) -> None:
        self.conn = conn
        self.max_recent_stops = max_recent_stops

    def cooldown_active(self) -> bool:
        """Check if global cooldown is currently active."""
        try:
            row = self.conn.execute(
                "SELECT value FROM system_state WHERE key='system_backoff_until'"
            ).fetchone()
            if not row or not row[0]:
                return False
            # Value is ISO timestamp; compare to now
            return row[0] > time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        except Exception:
            return False

    def queue_depth(self) -> int:
        """Return count of pending scheduled actions."""
        try:
            row = self.conn.execute(
                "SELECT COUNT(*) FROM scheduled_actions WHERE status='pending'"
            ).fetchone()
            return int(row[0]) if row else 0
        except Exception:
            return 0

    def write_lock_active(self) -> bool:
        """Check if Notion write_lock is enabled in system_settings."""
        try:
            row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='write_lock'"
            ).fetchone()
            if not row:
                return True  # default: locked
            return row[0] in ("true", "1", "True")
        except Exception:
            return True  # fail-safe: locked

    def get_setting(self, key: str) -> str | None:
        """Read a system_settings value by key."""
        try:
            row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key=?", (key,)
            ).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    def last_reconcile_ts(self, name: str) -> str | None:
        """Get timestamp of last successful reconcile for a named job."""
        try:
            row = self.conn.execute(
                "SELECT value FROM system_state WHERE key=?",
                (f"reconcile.{name}.last_ok_ts",),
            ).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    def recent_job_stops(self) -> list[dict[str, Any]]:
        """Read bounded list of recent job stop reasons."""
        try:
            row = self.conn.execute(
                "SELECT value FROM system_state WHERE key='recent_job_stops_json'"
            ).fetchone()
            if not row or not row[0]:
                return []
            return json.loads(row[0])
        except Exception:
            return []

    def prune_recent_job_stops(self) -> dict[str, Any]:
        """Trim recent_job_stops_json to max_recent_stops entries.

        Returns dict with action taken and before/after counts.
        """
        items = self.recent_job_stops()
        if len(items) <= self.max_recent_stops:
            return {"ok": True, "action": "noop", "count": len(items)}

        trimmed = items[-self.max_recent_stops:]
        try:
            self.conn.execute(
                """INSERT INTO system_state (key, value)
                   VALUES ('recent_job_stops_json', ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                (json.dumps(trimmed),),
            )
            self.conn.commit()
            return {
                "ok": True,
                "action": "pruned",
                "before": len(items),
                "after": len(trimmed),
            }
        except Exception:
            log.warning("prune_job_stops_error", exc_info=True)
            return {"ok": False, "error": "prune_failed"}

    def dump_all_kv(self) -> dict[str, str]:
        """Dump all system_state key-value pairs (for admin endpoint)."""
        result: dict[str, str] = {}
        try:
            rows = self.conn.execute("SELECT key, value FROM system_state").fetchall()
            for row in rows:
                result[row[0]] = row[0 + 1] if len(row) > 1 else row["value"]
        except Exception:
            pass

        # Also include system_settings
        try:
            rows = self.conn.execute("SELECT key, value FROM system_settings").fetchall()
            for row in rows:
                result[f"settings.{row[0]}"] = row[0 + 1] if len(row) > 1 else row["value"]
        except Exception:
            pass

        return result

    def mutation_guard(
        self,
        *,
        request_mutations: bool,
        default_safe_mode: bool = True,
    ) -> MutationGuardDecision:
        """Decide whether mutations are allowed based on system state.

        Checks write_lock and cooldown. Mutations are only allowed when:
        - request_mutations is True AND
        - write_lock is not active AND
        - cooldown is not active

        Args:
            request_mutations: Whether the caller wants to mutate.
            default_safe_mode: Safe-mode value when mutations are blocked.
                When mutations are allowed, safe_mode is set to False.
        """
        wl = self.write_lock_active()
        cd = self.cooldown_active()

        allow = request_mutations and not wl and not cd
        safe_mode = not allow if not default_safe_mode else (not allow or default_safe_mode)
        # Simplification: if allowed AND default_safe_mode=False → safe_mode=False
        # Otherwise safe_mode=True
        safe_mode = False if (allow and not default_safe_mode) else (not allow)

        reasons: list[str] = []
        if not request_mutations:
            reasons.append("mutations_not_requested")
        if wl:
            reasons.append("write_lock_active")
        if cd:
            reasons.append("cooldown_active")

        return MutationGuardDecision(
            allow_mutations=allow,
            safe_mode=safe_mode,
            reason="|".join(reasons) if reasons else "mutations_allowed",
            write_lock=wl,
            cooldown_active=cd,
        )

    def record_reconcile_success(self, name: str) -> None:
        """Record a successful reconcile timestamp."""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            self.conn.execute(
                """INSERT INTO system_state (key, value)
                   VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                (f"reconcile.{name}.last_ok_ts", now),
            )
            self.conn.commit()
        except Exception:
            log.warning("record_reconcile_success_error", extra={"name": name})

    def get_notion_health_summary(self) -> dict[str, Any]:
        """Produce a health summary for the admin health endpoint."""
        return {
            "cooldown_active": self.cooldown_active(),
            "write_lock_active": self.write_lock_active(),
            "queue_depth": self.queue_depth(),
            "template_version": self.get_setting("template_version"),
            "last_verified_at": self.get_setting("last_verified_at"),
            "last_heal_at": self.get_setting("last_heal_at"),
            "recent_job_stops_count": len(self.recent_job_stops()),
        }
