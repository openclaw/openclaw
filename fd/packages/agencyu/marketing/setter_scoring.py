"""Setter performance multiplier — adjusts combo scaling by setter close rate.

If a setter closes better than average, combos feeding them get a boost.
If worse, combos get a penalty. This prevents scaling spend into setters
who can't close.

Setter ID comes from payload_json.setter_id on call_showed / booking_complete
events in the attribution ledger.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.setter_scoring")


@dataclass
class SetterScore:
    """Performance stats for a single setter."""

    setter_id: str
    calls: int
    closes: int
    close_rate: float
    multiplier: float


def compute_setter_scores(
    conn: sqlite3.Connection,
    brand: str,
    since_ts: str,
    until_ts: str,
    *,
    min_calls: int = 10,
    mult_min: float = 0.85,
    mult_max: float = 1.20,
) -> dict[str, SetterScore]:
    """Compute setter close-rate scores and multipliers.

    The multiplier is relative to the average close rate across all
    eligible setters (those with >= min_calls).

    Args:
        conn: SQLite connection to the attribution ledger.
        brand: Brand to filter by.
        since_ts: Window start (ISO).
        until_ts: Window end (ISO).
        min_calls: Minimum calls to be eligible for scoring.
        mult_min: Floor for the multiplier (prevents extreme penalty).
        mult_max: Ceiling for the multiplier (prevents extreme boost).

    Returns:
        Dict of setter_id → SetterScore.
    """
    sql = """
    SELECT
      json_extract(e.payload_json, '$.setter_id') AS setter_id,
      SUM(CASE WHEN e.stage IN ('call_showed', 'appointment_attended', 'call_attended')
          THEN 1 ELSE 0 END) AS calls,
      SUM(CASE WHEN e.stage = 'checkout_paid' THEN 1 ELSE 0 END) AS closes
    FROM attribution_events e
    JOIN attribution_chains c ON c.chain_id = e.chain_id
    WHERE c.brand = ?
      AND e.ts >= ?
      AND e.ts <= ?
      AND json_extract(e.payload_json, '$.setter_id') IS NOT NULL
    GROUP BY setter_id
    """
    out: dict[str, SetterScore] = {}
    try:
        rows = conn.execute(sql, [brand, since_ts, until_ts]).fetchall()
    except Exception:
        log.warning("compute_setter_scores_error", extra={"brand": brand}, exc_info=True)
        return out

    # Build raw stats
    raw: list[tuple[str, int, int]] = []
    for r in rows:
        sid = str(r[0]) if not isinstance(r, sqlite3.Row) else str(r["setter_id"])
        calls = int(r[1] if not isinstance(r, sqlite3.Row) else r["calls"]) or 0
        closes = int(r[2] if not isinstance(r, sqlite3.Row) else r["closes"]) or 0
        raw.append((sid, calls, closes))

    # Baseline: average close rate across eligible setters
    eligible_rates = [
        c / a for (_, a, c) in raw if a >= min_calls and a > 0
    ]
    baseline = (sum(eligible_rates) / len(eligible_rates)) if eligible_rates else 0.05

    for sid, calls, closes in raw:
        cr = (closes / calls) if calls > 0 else 0.0
        raw_mult = (cr / baseline) if baseline > 0 else 1.0
        mult = max(mult_min, min(mult_max, raw_mult))
        out[sid] = SetterScore(
            setter_id=sid,
            calls=calls,
            closes=closes,
            close_rate=cr,
            multiplier=mult,
        )

    return out
