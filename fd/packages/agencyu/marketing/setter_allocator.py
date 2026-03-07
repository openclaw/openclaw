"""Setter Allocator — intelligent lead routing by setter performance.

Routes high-value leads to high-performing setters automatically.

Provides:
  - allocate_lead(): route a lead to the optimal setter
  - get_setter_rankings(): ranked list of setters by composite score
  - rebalance_queue(): redistribute queued leads for fairness
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.agencyu.marketing.setter_scoring import compute_setter_scores
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.setter_allocator")


# ── Data models ──


@dataclass(frozen=True)
class SetterRanking:
    """Setter ranked for lead allocation."""

    setter_id: str
    display_name: str
    brand: str
    close_rate: float
    show_rate: float
    avg_response_minutes: float
    composite_score: float  # 0-100
    current_queue: int
    max_queue: int
    available: bool


@dataclass(frozen=True)
class AllocationResult:
    """Result of lead allocation decision."""

    setter_id: str
    setter_name: str
    reason: str
    lead_tier: str
    composite_score: float
    fallback: bool


# ── Weights for composite score ──

_W_CLOSE_RATE = 0.40
_W_SHOW_RATE = 0.25
_W_RESPONSE_TIME = 0.20
_W_QUEUE_HEADROOM = 0.15

# Thresholds
_HIGH_TIER_THRESHOLD = 500_000  # $5k+ revenue_tier = high-value
_MAX_RESPONSE_MINUTES = 60  # Normalize response time against this cap


def get_setter_rankings(
    conn: sqlite3.Connection,
    brand: str,
    *,
    since_ts: str = "",
    until_ts: str = "",
    window_days: int = 30,
) -> list[SetterRanking]:
    """Get ranked list of setters for a brand by composite score.

    Combines close rate, show rate, response time, and queue headroom.
    """
    from datetime import UTC, datetime, timedelta

    if not since_ts:
        now = datetime.now(UTC)
        since_ts = (now - timedelta(days=window_days)).isoformat()
    if not until_ts:
        until_ts = datetime.now(UTC).isoformat()

    # Get close-rate scores from attribution data
    scores = compute_setter_scores(conn, brand, since_ts, until_ts)

    # Get setter metadata from setter_daily_metrics
    rankings: list[SetterRanking] = []

    try:
        rows = conn.execute(
            """SELECT
                setter_id,
                COALESCE(MAX(display_name), setter_id) AS display_name,
                SUM(booked_calls) AS total_booked,
                SUM(appointments_showed) AS total_showed,
                AVG(avg_response_time_minutes) AS avg_response,
                MAX(current_queue_size) AS current_queue
            FROM setter_daily_metrics
            WHERE brand = ? AND date >= ?
            GROUP BY setter_id""",
            (brand, since_ts[:10]),
        ).fetchall()
    except Exception:
        log.debug("setter_rankings_query_error", exc_info=True)
        rows = []

    for r in rows:
        sid = r["setter_id"]
        score_data = scores.get(sid)

        close_rate = score_data.close_rate if score_data else 0.0
        total_booked = int(r["total_booked"] or 0)
        total_showed = int(r["total_showed"] or 0)
        show_rate = total_showed / max(1, total_booked)
        avg_resp = float(r["avg_response"] or _MAX_RESPONSE_MINUTES)
        current_q = int(r["current_queue"] or 0)
        max_q = 20  # Default max queue per setter

        # Composite: higher is better
        cr_score = min(1.0, close_rate / 0.30) * 100  # 30% close = perfect
        sr_score = min(1.0, show_rate / 0.80) * 100  # 80% show = perfect
        rt_score = max(0, (1 - avg_resp / _MAX_RESPONSE_MINUTES)) * 100
        qh_score = max(0, (1 - current_q / max_q)) * 100

        composite = (
            cr_score * _W_CLOSE_RATE
            + sr_score * _W_SHOW_RATE
            + rt_score * _W_RESPONSE_TIME
            + qh_score * _W_QUEUE_HEADROOM
        )

        rankings.append(SetterRanking(
            setter_id=sid,
            display_name=r["display_name"] or sid,
            brand=brand,
            close_rate=round(close_rate, 3),
            show_rate=round(show_rate, 3),
            avg_response_minutes=round(avg_resp, 1),
            composite_score=round(composite, 1),
            current_queue=current_q,
            max_queue=max_q,
            available=current_q < max_q,
        ))

    return sorted(rankings, key=lambda r: r.composite_score, reverse=True)


def allocate_lead(
    conn: sqlite3.Connection,
    brand: str,
    lead: dict[str, Any],
) -> AllocationResult | None:
    """Route a lead to the optimal available setter.

    Strategy:
    - High-value leads (revenue_tier >= $5k) → top-ranked setter
    - Standard leads → round-robin among available setters
    - If top setter queue full → fallback to next available

    Returns None if no setters are available.
    """
    revenue_cents = lead.get("revenue_tier_cents") or lead.get("estimated_value_cents") or 0
    is_high_value = revenue_cents >= _HIGH_TIER_THRESHOLD
    lead_tier = "high" if is_high_value else "standard"

    rankings = get_setter_rankings(conn, brand)
    available = [r for r in rankings if r.available]

    if not available:
        log.warning("no_setters_available", extra={"brand": brand})
        return None

    if is_high_value:
        # Route to highest-scoring setter
        pick = available[0]
        return AllocationResult(
            setter_id=pick.setter_id,
            setter_name=pick.display_name,
            reason=f"high_value_lead_routed_to_top_setter (score={pick.composite_score})",
            lead_tier=lead_tier,
            composite_score=pick.composite_score,
            fallback=False,
        )

    # Standard: round-robin by lightest queue
    by_queue = sorted(available, key=lambda r: r.current_queue)
    pick = by_queue[0]

    return AllocationResult(
        setter_id=pick.setter_id,
        setter_name=pick.display_name,
        reason=f"standard_round_robin (queue={pick.current_queue})",
        lead_tier=lead_tier,
        composite_score=pick.composite_score,
        fallback=False,
    )


def rebalance_queue(
    conn: sqlite3.Connection,
    brand: str,
) -> dict[str, Any]:
    """Redistribute queued leads for fairness when setters come online/offline.

    Returns summary of rebalanced leads.
    """
    rankings = get_setter_rankings(conn, brand)
    if not rankings:
        return {"ok": True, "rebalanced": 0, "reason": "no_setters"}

    available = [r for r in rankings if r.available]
    overloaded = [r for r in rankings if r.current_queue >= r.max_queue]

    if not overloaded or not available:
        return {"ok": True, "rebalanced": 0, "reason": "no_rebalance_needed"}

    rebalanced = 0
    recommendations: list[dict[str, str]] = []

    for over in overloaded:
        excess = over.current_queue - (over.max_queue - 2)  # Leave 2 slots buffer
        if excess <= 0:
            continue

        for avail in available:
            if excess <= 0:
                break
            headroom = avail.max_queue - avail.current_queue
            transfer = min(excess, headroom)
            if transfer > 0:
                recommendations.append({
                    "from": over.setter_id,
                    "to": avail.setter_id,
                    "count": str(transfer),
                })
                excess -= transfer
                rebalanced += transfer

    return {
        "ok": True,
        "rebalanced": rebalanced,
        "recommendations": recommendations,
        "overloaded_setters": len(overloaded),
        "available_setters": len(available),
    }
