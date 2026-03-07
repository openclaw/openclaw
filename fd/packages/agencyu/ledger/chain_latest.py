"""Chain latest stage tracker — maintains mv_chain_latest rollup.

upsert_chain_latest() updates the materialized view after each event insertion,
keeping the latest stage, showed/closed/refunded flags current per chain.
"""
from __future__ import annotations

import sqlite3

from packages.common.logging import get_logger

log = get_logger("agencyu.ledger.chain_latest")

_SHOWED_STAGES = ("call_showed", "appointment_attended", "call_attended")
_CLOSED_STAGES = ("checkout_paid",)
_REFUND_STAGES = ("refund_issued", "charge_refunded")


def upsert_chain_latest(
    conn: sqlite3.Connection,
    *,
    chain_id: str,
    brand: str,
    combo_id: str,
    stage: str,
    ts: str,
) -> None:
    """Update mv_chain_latest after an event insertion.

    Maintains latest_stage, total_events, and boolean flags for
    showed/closed/refunded. Uses INSERT ... ON CONFLICT to upsert.
    """
    has_showed = 1 if stage in _SHOWED_STAGES else 0
    has_closed = 1 if stage in _CLOSED_STAGES else 0
    has_refunded = 1 if stage in _REFUND_STAGES else 0

    try:
        conn.execute(
            """INSERT INTO mv_chain_latest
            (chain_id, brand, combo_id, latest_stage, latest_ts,
             total_events, has_showed, has_closed, has_refunded, refreshed_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))
            ON CONFLICT(chain_id) DO UPDATE SET
              latest_stage = CASE
                WHEN excluded.latest_ts >= mv_chain_latest.latest_ts
                THEN excluded.latest_stage
                ELSE mv_chain_latest.latest_stage
              END,
              latest_ts = CASE
                WHEN excluded.latest_ts >= mv_chain_latest.latest_ts
                THEN excluded.latest_ts
                ELSE mv_chain_latest.latest_ts
              END,
              total_events = mv_chain_latest.total_events + 1,
              has_showed = MAX(mv_chain_latest.has_showed, excluded.has_showed),
              has_closed = MAX(mv_chain_latest.has_closed, excluded.has_closed),
              has_refunded = MAX(mv_chain_latest.has_refunded, excluded.has_refunded),
              refreshed_at = datetime('now')
            """,
            (chain_id, brand, combo_id, stage, ts,
             has_showed, has_closed, has_refunded),
        )
        conn.commit()
    except Exception:
        log.warning(
            "upsert_chain_latest_error",
            extra={"chain_id": chain_id, "stage": stage},
            exc_info=True,
        )
