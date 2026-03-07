"""Circuit breaker for Notion audit mirroring.

Auto-pauses mirroring after error spikes to prevent runaway failures.
Uses system_state table for cooldown persistence and audit_logs for error counting.

Keys used in system_state:
- notion_audit_mirror_cooldown_until_epoch
- notion_audit_mirror_last_trip_reason
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.services.circuit_breaker")

# Lazy import to avoid circular dependency
_system_state_mod = None


def _get_system_state_mod():
    global _system_state_mod
    if _system_state_mod is None:
        from packages.agencyu.services import system_state as _mod
        _system_state_mod = _mod
    return _system_state_mod


@dataclass
class CircuitBreakerConfig:
    """Configuration for the circuit breaker."""

    # Trip if >= error_threshold errors occur within window_seconds
    window_seconds: int = 900  # 15 minutes
    error_threshold: int = 6
    # Pause mirroring for this long after tripping
    cooldown_seconds: int = 1800  # 30 minutes


class CircuitBreaker:
    """Circuit breaker backed by system_state + audit_logs tables.

    Tracks error rates and pauses mirroring when failures spike.
    """

    KEY_COOLDOWN = "notion_audit_mirror_cooldown_until_epoch"
    KEY_TRIP_REASON = "notion_audit_mirror_last_trip_reason"

    def __init__(
        self,
        conn: sqlite3.Connection,
        cfg: CircuitBreakerConfig | None = None,
    ) -> None:
        self.conn = conn
        self.cfg = cfg or CircuitBreakerConfig()

    def cooldown_active(self) -> tuple[bool, int | None, str | None]:
        """Check if the circuit breaker cooldown is currently active.

        Returns:
            (is_active, cooldown_until_epoch, last_trip_reason)
        """
        until = self._get_int(self.KEY_COOLDOWN)
        reason = self._get_str(self.KEY_TRIP_REASON)
        if until and int(time.time()) < until:
            return True, until, reason
        return False, until, reason

    def consider_trip(
        self, *, mirror_job_errors: int, reason: str = "notion_write_errors"
    ) -> bool:
        """Evaluate whether to trip the breaker based on current + recent errors.

        Args:
            mirror_job_errors: Number of errors from the current mirror job run.
            reason: Human-readable reason for the trip.

        Returns:
            True if the breaker tripped (or was already cooling down).
        """
        active, _, _ = self.cooldown_active()
        if active:
            return True

        recent_failures = self._count_recent_failures(
            system="notion", window_seconds=self.cfg.window_seconds
        )
        total = recent_failures + mirror_job_errors

        if total >= self.cfg.error_threshold:
            until = int(time.time()) + self.cfg.cooldown_seconds
            trip_msg = f"{reason} (recent_failures={recent_failures}, job_errors={mirror_job_errors})"
            self._set(self.KEY_COOLDOWN, str(until))
            self._set(self.KEY_TRIP_REASON, trip_msg)
            log.warning("circuit_breaker_tripped", extra={
                "until_epoch": until,
                "reason": trip_msg,
            })
            # Push to recent job stops ring buffer
            try:
                mod = _get_system_state_mod()
                state = mod.SystemState(self.conn)
                mod.push_recent_stop(state, {
                    "ts": utc_now_iso(),
                    "job": "circuit_breaker",
                    "reason": trip_msg,
                    "cooldown_until_epoch": until,
                })
            except Exception:
                pass  # non-critical
            return True

        return False

    def clear(self) -> None:
        """Manually clear the cooldown (admin override)."""
        self._set(self.KEY_COOLDOWN, "0")
        self._set(self.KEY_TRIP_REASON, "")
        log.info("circuit_breaker_cleared")

    # ─────────────────────────────────────────
    # Internal
    # ─────────────────────────────────────────

    def _count_recent_failures(self, system: str, window_seconds: int) -> int:
        """Count failed audit_logs entries within the time window."""
        cutoff_epoch = int(time.time()) - window_seconds
        cutoff_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cutoff_epoch))
        try:
            row = self.conn.execute(
                "SELECT COUNT(1) FROM audit_logs WHERE system=? AND result='failed' AND ts>=?",
                (system, cutoff_iso),
            ).fetchone()
            return int(row[0]) if row else 0
        except Exception:
            return 0

    def _get_str(self, key: str) -> str | None:
        try:
            row = self.conn.execute(
                "SELECT value FROM system_state WHERE key=?", (key,)
            ).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    def _get_int(self, key: str) -> int | None:
        val = self._get_str(key)
        if val is None or val == "":
            return None
        try:
            return int(val)
        except (ValueError, TypeError):
            return None

    def _set(self, key: str, value: str) -> None:
        try:
            self.conn.execute(
                """INSERT INTO system_state(key, value, updated_ts)
                   VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts""",
                (key, value, utc_now_iso()),
            )
            self.conn.commit()
        except Exception as exc:
            log.error("circuit_breaker_state_write_failed", extra={"error": str(exc)})
