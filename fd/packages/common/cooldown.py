"""Global cooldown (circuit breaker) for Trello API calls.

Tracks consecutive failures in system_state table. When threshold is reached,
sets system_backoff_until to block batch jobs from hammering Trello.

Keys stored:
  - system_backoff_until: ISO timestamp until which batch jobs should exit early
  - trello_consecutive_failures: int counter
  - trello_last_error_ts: ISO timestamp of last failure
  - trello_last_429_ts: ISO timestamp of last rate-limit hit
"""
from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.clock import now_ts


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _parse_iso(s: str) -> datetime | None:
    try:
        clean = s.replace("Z", "+00:00") if s.endswith("Z") else s
        return datetime.fromisoformat(clean)
    except Exception:
        return None


def _get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM system_state WHERE key=?", (key,)
    ).fetchone()
    return row[0] if row else None


def _set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """INSERT INTO system_state(key, value, updated_ts) VALUES(?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts""",
        (key, value, str(now_ts())),
    )
    conn.commit()


def is_cooldown_active(conn: sqlite3.Connection) -> bool:
    """Return True if system backoff is currently in effect."""
    until = _get(conn, "system_backoff_until")
    if not until:
        return False
    dt = _parse_iso(until)
    if not dt:
        return False
    return _utcnow() < dt


def get_cooldown(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return current cooldown state for admin visibility."""
    until = _get(conn, "system_backoff_until")
    failures = _get(conn, "trello_consecutive_failures") or "0"
    last_error = _get(conn, "trello_last_error_ts")
    last_429 = _get(conn, "trello_last_429_ts")
    return {
        "active": is_cooldown_active(conn),
        "system_backoff_until": until,
        "trello_consecutive_failures": int(failures),
        "trello_last_error_ts": last_error,
        "trello_last_429_ts": last_429,
    }


def reset_cooldown(conn: sqlite3.Connection) -> None:
    """Manually clear cooldown state."""
    _set(conn, "system_backoff_until", "")
    _set(conn, "trello_consecutive_failures", "0")


def record_trello_success(conn: sqlite3.Connection) -> None:
    """Reset consecutive failure counter on successful Trello call."""
    _set(conn, "trello_consecutive_failures", "0")


def record_trello_failure_and_maybe_trip(
    conn: sqlite3.Connection,
    *,
    is_rate_limit: bool,
    max_failures_before_trip: int = 4,
    cooldown_seconds: int = 300,
    cooldown_max_seconds: int = 3600,
) -> dict[str, Any]:
    """Increment failure counter; trip breaker when threshold reached.

    Cooldown scales exponentially: base * 2^(failures - threshold), capped.
    """
    failures = int(_get(conn, "trello_consecutive_failures") or "0") + 1
    _set(conn, "trello_consecutive_failures", str(failures))
    _set(conn, "trello_last_error_ts", _utcnow().isoformat().replace("+00:00", "Z"))
    if is_rate_limit:
        _set(conn, "trello_last_429_ts", _utcnow().isoformat().replace("+00:00", "Z"))

    tripped = False
    until_iso = _get(conn, "system_backoff_until") or ""

    if failures >= max_failures_before_trip:
        scale = max(0, failures - max_failures_before_trip)
        seconds = min(cooldown_seconds * (2 ** scale), cooldown_max_seconds)
        until = _utcnow() + timedelta(seconds=seconds)
        until_iso = until.isoformat().replace("+00:00", "Z")
        _set(conn, "system_backoff_until", until_iso)
        tripped = True

    return {
        "failures": failures,
        "tripped": tripped,
        "is_rate_limit": is_rate_limit,
        "system_backoff_until": until_iso,
    }
