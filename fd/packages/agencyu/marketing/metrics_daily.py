"""Daily KPI metrics for Brand Switcher badge lines.

Provides today's primary KPI counts for each brand:
- Full Digital: calls booked today (booking_complete events)
- CUTMV: trials started today + paid conversions today

Includes yesterday comparison for delta arrows (↑ ↓ →).

Uses the attribution ledger (attribution_events + attribution_chains)
with UTC day boundaries. All queries exclude refunded payments.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.metrics_daily")


@dataclass
class TodayFD:
    """Full Digital daily KPI snapshot."""

    calls_booked: int


@dataclass
class TodayCUTMV:
    """CUTMV daily KPI snapshot."""

    trials: int
    paid: int


# ── Day range helpers ──


def _utc_day_range(day_offset: int = 0) -> tuple[str, str]:
    """Return (start, end) ISO timestamps for a UTC day.

    day_offset=0 → today, day_offset=-1 → yesterday.
    """
    now = datetime.now(UTC)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=day_offset)
    end = start + timedelta(days=1)
    return start.isoformat(), end.isoformat()


# ── Delta formatting ──


def delta_arrow(delta: int) -> str:
    """Return a tiny arrow character based on delta direction."""
    if delta > 0:
        return "\u2191"  # ↑
    if delta < 0:
        return "\u2193"  # ↓
    return "\u2192"  # →


def trend_color(delta: int) -> str:
    """Return a color key for admin UI chip styling."""
    if delta > 0:
        return "green"
    if delta < 0:
        return "red"
    return "yellow"


# ── Per-brand metric queries (parameterised by day_offset) ──


def get_fd_calls_booked(conn: sqlite3.Connection, day_offset: int = 0) -> int:
    """Count Full Digital booking_complete events for a given UTC day."""
    start, end = _utc_day_range(day_offset)
    try:
        row = conn.execute(
            """SELECT COUNT(*) AS n
            FROM attribution_events e
            JOIN attribution_chains c ON c.chain_id = e.chain_id
            WHERE c.brand = 'fulldigital'
              AND e.stage = 'booking_complete'
              AND e.ts >= ? AND e.ts < ?""",
            (start, end),
        ).fetchone()
        return int(row[0]) if row else 0
    except Exception:
        log.warning("get_fd_calls_booked_error", exc_info=True)
        return 0


def get_cutmv_trials(conn: sqlite3.Connection, day_offset: int = 0) -> int:
    """Count CUTMV trial_started events for a given UTC day."""
    start, end = _utc_day_range(day_offset)
    try:
        row = conn.execute(
            """SELECT COUNT(*) AS n
            FROM attribution_events e
            JOIN attribution_chains c ON c.chain_id = e.chain_id
            WHERE c.brand = 'cutmv'
              AND e.stage IN ('trial_started', 'signup_trial_started')
              AND e.ts >= ? AND e.ts < ?""",
            (start, end),
        ).fetchone()
        return int(row[0]) if row else 0
    except Exception:
        log.warning("get_cutmv_trials_error", exc_info=True)
        return 0


def get_cutmv_paid(conn: sqlite3.Connection, day_offset: int = 0) -> int:
    """Count CUTMV paid conversions for a given UTC day (refunds excluded)."""
    start, end = _utc_day_range(day_offset)
    try:
        row = conn.execute(
            """SELECT COUNT(*) AS n
            FROM attribution_events e
            JOIN attribution_chains c ON c.chain_id = e.chain_id
            WHERE c.brand = 'cutmv'
              AND e.stage IN ('checkout_paid', 'stripe_payment_succeeded')
              AND e.ts >= ? AND e.ts < ?
              AND NOT EXISTS (
                  SELECT 1 FROM attribution_events r
                  WHERE r.chain_id = e.chain_id
                    AND r.stage IN ('refund_issued', 'charge_refunded')
              )""",
            (start, end),
        ).fetchone()
        return int(row[0]) if row else 0
    except Exception:
        log.warning("get_cutmv_paid_error", exc_info=True)
        return 0


# ── Legacy dataclass wrappers (used by existing code) ──


def get_today_fd(conn: sqlite3.Connection) -> TodayFD:
    """Count Full Digital booked calls today."""
    return TodayFD(calls_booked=get_fd_calls_booked(conn, 0))


def get_today_cutmv(conn: sqlite3.Connection) -> TodayCUTMV:
    """Count CUTMV trials and paid conversions today."""
    return TodayCUTMV(
        trials=get_cutmv_trials(conn, 0),
        paid=get_cutmv_paid(conn, 0),
    )


# ── Tile summary with deltas ──


def build_brand_tile_summary(conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
    """Build badge metrics with today + yesterday for delta computation.

    Returns:
        {"fulldigital": {"calls_booked_today": int, "calls_booked_yesterday": int},
         "cutmv": {"trials_today": int, "paid_today": int, "paid_yesterday": int}}
    """
    return {
        "fulldigital": {
            "calls_booked_today": get_fd_calls_booked(conn, 0),
            "calls_booked_yesterday": get_fd_calls_booked(conn, -1),
        },
        "cutmv": {
            "trials_today": get_cutmv_trials(conn, 0),
            "paid_today": get_cutmv_paid(conn, 0),
            "paid_yesterday": get_cutmv_paid(conn, -1),
        },
    }
