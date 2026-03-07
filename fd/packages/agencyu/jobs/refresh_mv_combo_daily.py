"""Rollup refresh job — rebuilds mv_combo_daily from attribution ledger.

SQLite doesn't have real materialized views, so this job truncates and
re-inserts from the source tables. Safe to run multiple times (idempotent).

Designed to run as a scheduled job (e.g. every 6 hours via cron or orchestrator).

Precedence rules for multi-source events (GHL + Calendly):
  - For calls_booked and calls_showed, GHL is the primary source.
  - Calendly events are only counted when no GHL event exists for the
    same appointment_key. This prevents double-counting when both systems
    emit booking/showed events for the same appointment.
"""
from __future__ import annotations

import sqlite3
import time

from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.refresh_mv_combo_daily")

_SHOWED_STAGES = ("call_showed", "appointment_attended", "call_attended")
_REFUND_STAGES = ("refund_issued", "charge_refunded")
_BOOKING_STAGES = ("booking_complete",)

# ── Precedence-aware CTEs for calls_booked / calls_showed ──

# Precedence logic:
# 1. Events WITHOUT appointment_key are always counted (legacy/no cross-source dedup possible).
# 2. For events WITH appointment_key: GHL wins; Calendly only counted if no GHL for same key.

_CALLS_BOOKED_PRECEDENCE_SQL = """
WITH booked_raw AS (
  SELECT
    c.combo_id,
    c.brand,
    DATE(e.ts) AS day,
    json_extract(e.payload_json, '$.appointment_key') AS appointment_key,
    e.source
  FROM attribution_events e
  JOIN attribution_chains c ON c.chain_id = e.chain_id
  WHERE e.stage = 'booking_complete'
),
-- Events without appointment_key: always counted (no dedup possible)
booked_no_key AS (
  SELECT combo_id, brand, day
  FROM booked_raw
  WHERE appointment_key IS NULL OR appointment_key = ''
),
-- Events with appointment_key: apply GHL precedence
booked_ghl AS (
  SELECT combo_id, brand, day, appointment_key
  FROM booked_raw
  WHERE source = 'ghl' AND appointment_key IS NOT NULL AND appointment_key != ''
),
booked_keyed_deduped AS (
  SELECT combo_id, brand, day FROM booked_ghl
  UNION ALL
  SELECT b.combo_id, b.brand, b.day
  FROM booked_raw b
  WHERE b.source != 'ghl'
    AND b.appointment_key IS NOT NULL AND b.appointment_key != ''
    AND NOT EXISTS (
      SELECT 1 FROM booked_ghl g
      WHERE g.combo_id = b.combo_id AND g.day = b.day
        AND g.appointment_key = b.appointment_key
    )
),
booked_all AS (
  SELECT combo_id, brand, day FROM booked_no_key
  UNION ALL
  SELECT combo_id, brand, day FROM booked_keyed_deduped
)
SELECT combo_id, brand, day, COUNT(*) AS calls_booked
FROM booked_all
GROUP BY combo_id, brand, day
"""

_CALLS_SHOWED_PRECEDENCE_SQL = """
WITH showed_raw AS (
  SELECT
    c.combo_id,
    c.brand,
    DATE(e.ts) AS day,
    json_extract(e.payload_json, '$.appointment_key') AS appointment_key,
    e.source
  FROM attribution_events e
  JOIN attribution_chains c ON c.chain_id = e.chain_id
  WHERE e.stage IN ({showed_ph})
),
showed_no_key AS (
  SELECT combo_id, brand, day
  FROM showed_raw
  WHERE appointment_key IS NULL OR appointment_key = ''
),
showed_ghl AS (
  SELECT combo_id, brand, day, appointment_key
  FROM showed_raw
  WHERE source = 'ghl' AND appointment_key IS NOT NULL AND appointment_key != ''
),
showed_keyed_deduped AS (
  SELECT combo_id, brand, day FROM showed_ghl
  UNION ALL
  SELECT s.combo_id, s.brand, s.day
  FROM showed_raw s
  WHERE s.source != 'ghl'
    AND s.appointment_key IS NOT NULL AND s.appointment_key != ''
    AND NOT EXISTS (
      SELECT 1 FROM showed_ghl g
      WHERE g.combo_id = s.combo_id AND g.day = s.day
        AND g.appointment_key = s.appointment_key
    )
),
showed_all AS (
  SELECT combo_id, brand, day FROM showed_no_key
  UNION ALL
  SELECT combo_id, brand, day FROM showed_keyed_deduped
)
SELECT combo_id, brand, day, COUNT(*) AS calls_showed
FROM showed_all
GROUP BY combo_id, brand, day
"""


def refresh_mv_combo_daily(conn: sqlite3.Connection) -> dict:
    """Rebuild mv_combo_daily from attribution_events + attribution_chains.

    Uses precedence logic: GHL events preferred over Calendly for
    calls_booked and calls_showed counts. Revenue/refunds are source-agnostic.

    Returns dict with row count and elapsed time.
    """
    t0 = time.monotonic()
    showed_ph = ",".join("?" * len(_SHOWED_STAGES))
    refund_ph = ",".join("?" * len(_REFUND_STAGES))

    try:
        conn.execute("DELETE FROM mv_combo_daily")

        # Step 1: Insert base rows from revenue/refund/application counts (source-agnostic)
        conn.execute(
            f"""INSERT INTO mv_combo_daily
            (combo_id, brand, day, calls_booked, calls_showed, closes,
             gross_revenue_usd, refunds_usd, applications, refreshed_at)
            SELECT
              c.combo_id,
              c.brand,
              DATE(e.ts) AS day,
              0,  -- filled by precedence update below
              0,  -- filled by precedence update below
              SUM(CASE WHEN e.stage = 'checkout_paid' THEN 1 ELSE 0 END),
              COALESCE(SUM(
                CASE WHEN e.stage = 'checkout_paid' THEN
                  COALESCE(
                    CAST(json_extract(e.payload_json, '$.amount_usd') AS REAL),
                    CAST(json_extract(e.payload_json, '$.amount') AS REAL) / 100.0,
                    0.0
                  )
                ELSE 0.0 END
              ), 0),
              COALESCE(SUM(
                CASE WHEN e.stage IN ({refund_ph}) THEN
                  COALESCE(
                    CAST(json_extract(e.payload_json, '$.refund_amount_usd') AS REAL),
                    CAST(json_extract(e.payload_json, '$.amount') AS REAL) / 100.0,
                    0.0
                  )
                ELSE 0.0 END
              ), 0),
              SUM(CASE WHEN e.stage = 'application_submit' THEN 1 ELSE 0 END),
              datetime('now')
            FROM attribution_events e
            JOIN attribution_chains c ON c.chain_id = e.chain_id
            GROUP BY c.combo_id, c.brand, DATE(e.ts)
            """,
            [*_REFUND_STAGES],
        )

        # Step 2: Compute calls_booked with GHL precedence
        booked_rows = conn.execute(_CALLS_BOOKED_PRECEDENCE_SQL).fetchall()
        for row in booked_rows:
            combo_id, brand, day, calls_booked = row
            conn.execute(
                """UPDATE mv_combo_daily SET calls_booked = ?
                WHERE combo_id = ? AND brand = ? AND day = ?""",
                (calls_booked, combo_id, brand, day),
            )

        # Step 3: Compute calls_showed with GHL precedence
        showed_sql = _CALLS_SHOWED_PRECEDENCE_SQL.format(showed_ph=showed_ph)
        showed_rows = conn.execute(showed_sql, [*_SHOWED_STAGES]).fetchall()
        for row in showed_rows:
            combo_id, brand, day, calls_showed = row
            conn.execute(
                """UPDATE mv_combo_daily SET calls_showed = ?
                WHERE combo_id = ? AND brand = ? AND day = ?""",
                (calls_showed, combo_id, brand, day),
            )

        conn.commit()

        row = conn.execute("SELECT COUNT(*) FROM mv_combo_daily").fetchone()
        count = row[0] if row else 0
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        log.info(
            "mv_combo_daily_refreshed",
            extra={"rows": count, "elapsed_ms": elapsed_ms},
        )
        return {"ok": True, "rows": count, "elapsed_ms": elapsed_ms}

    except Exception:
        log.warning("mv_combo_daily_refresh_error", exc_info=True)
        return {"ok": False, "error": "refresh_failed"}


def refresh_mv_setter_daily(conn: sqlite3.Connection) -> dict:
    """Rebuild mv_setter_daily from attribution ledger."""
    t0 = time.monotonic()

    try:
        conn.execute("DELETE FROM mv_setter_daily")
        conn.execute(
            """INSERT INTO mv_setter_daily
            (setter_id, brand, day, calls, closes, revenue_usd, refreshed_at)
            SELECT
              json_extract(e.payload_json, '$.setter_id') AS setter_id,
              c.brand,
              DATE(e.ts) AS day,
              SUM(CASE WHEN e.stage IN ('call_showed', 'appointment_attended', 'call_attended')
                  THEN 1 ELSE 0 END),
              SUM(CASE WHEN e.stage = 'checkout_paid' THEN 1 ELSE 0 END),
              COALESCE(SUM(
                CASE WHEN e.stage = 'checkout_paid' THEN
                  COALESCE(
                    CAST(json_extract(e.payload_json, '$.amount_usd') AS REAL),
                    0.0
                  )
                ELSE 0.0 END
              ), 0),
              datetime('now')
            FROM attribution_events e
            JOIN attribution_chains c ON c.chain_id = e.chain_id
            WHERE json_extract(e.payload_json, '$.setter_id') IS NOT NULL
            GROUP BY setter_id, c.brand, DATE(e.ts)
            """
        )
        conn.commit()

        row = conn.execute("SELECT COUNT(*) FROM mv_setter_daily").fetchone()
        count = row[0] if row else 0
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        log.info(
            "mv_setter_daily_refreshed",
            extra={"rows": count, "elapsed_ms": elapsed_ms},
        )
        return {"ok": True, "rows": count, "elapsed_ms": elapsed_ms}

    except Exception:
        log.warning("mv_setter_daily_refresh_error", exc_info=True)
        return {"ok": False, "error": "refresh_failed"}


def refresh_all_rollups(conn: sqlite3.Connection) -> dict:
    """Refresh all materialized view rollups."""
    combo = refresh_mv_combo_daily(conn)
    setter = refresh_mv_setter_daily(conn)
    return {
        "mv_combo_daily": combo,
        "mv_setter_daily": setter,
    }
