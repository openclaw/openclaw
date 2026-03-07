"""Standardized ledger metrics — canonical call + revenue stats per combo.

Ensures GHL, ClickFunnels, and Stripe produce ONE truth via the
attribution ledger. All quality gates and policy signals consume
these stats rather than ad-hoc per-query counts.

Definitions:
  calls_booked:  stage IN ('booking_complete')
  calls_showed:  stage IN ('call_showed', 'appointment_attended', 'call_attended')
  calls_observed: calls_showed if available, else calls_booked (fallback)
  closes:        stage = 'checkout_paid' (Stripe paid, not refunded)
  gross_revenue: sum of checkout_paid amount_usd
  refunds:       sum of refund_issued / charge_refunded amount
  net_revenue:   gross - refunds
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.ledger_metrics")

# Canonical stage names for showed calls
_SHOWED_STAGES = ("call_showed", "appointment_attended", "call_attended")
_REFUND_STAGES = ("refund_issued", "charge_refunded")


@dataclass
class LedgerComboCallStats:
    """Call metrics for a single combo from the attribution ledger."""

    calls_booked: int = 0
    calls_showed: int = 0

    @property
    def calls_observed(self) -> int:
        """Showed calls if tracked, else fall back to booked."""
        return self.calls_showed if self.calls_showed > 0 else self.calls_booked


@dataclass
class LedgerComboRevenueStats:
    """Revenue metrics for a single combo from the attribution ledger."""

    closes: int = 0
    gross_revenue_usd: float = 0.0
    refunds_usd: float = 0.0

    @property
    def net_revenue_usd(self) -> float:
        return self.gross_revenue_usd - self.refunds_usd


class LedgerMetrics:
    """Query the attribution ledger for standardized call + revenue stats.

    Uses the existing attribution_events + attribution_chains tables.
    All queries are windowed by brand + time range.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def get_calls_by_combo(
        self,
        brand: str,
        since_ts: str,
        until_ts: str,
    ) -> dict[str, LedgerComboCallStats]:
        """Get booked + showed call counts per combo_id."""
        showed_placeholders = ",".join("?" * len(_SHOWED_STAGES))
        sql = f"""
        SELECT
          c.combo_id AS combo_id,
          SUM(CASE WHEN e.stage = 'booking_complete' THEN 1 ELSE 0 END) AS calls_booked,
          SUM(CASE WHEN e.stage IN ({showed_placeholders}) THEN 1 ELSE 0 END) AS calls_showed
        FROM attribution_events e
        JOIN attribution_chains c ON c.chain_id = e.chain_id
        WHERE c.brand = ?
          AND e.ts >= ?
          AND e.ts <= ?
        GROUP BY c.combo_id
        """
        out: dict[str, LedgerComboCallStats] = {}
        try:
            rows = self.conn.execute(
                sql, [*_SHOWED_STAGES, brand, since_ts, until_ts]
            ).fetchall()
            for r in rows:
                combo_id = str(r[0]) if not isinstance(r, sqlite3.Row) else str(r["combo_id"])
                booked = int(r[1] if not isinstance(r, sqlite3.Row) else r["calls_booked"]) or 0
                showed = int(r[2] if not isinstance(r, sqlite3.Row) else r["calls_showed"]) or 0
                out[combo_id] = LedgerComboCallStats(
                    calls_booked=booked,
                    calls_showed=showed,
                )
        except Exception:
            log.warning("get_calls_by_combo_error", extra={"brand": brand}, exc_info=True)
        return out

    def get_revenue_by_combo(
        self,
        brand: str,
        since_ts: str,
        until_ts: str,
    ) -> dict[str, LedgerComboRevenueStats]:
        """Get closes + gross/refund revenue per combo_id."""
        refund_placeholders = ",".join("?" * len(_REFUND_STAGES))
        sql = f"""
        SELECT
          c.combo_id AS combo_id,
          SUM(CASE WHEN e.stage = 'checkout_paid' THEN 1 ELSE 0 END) AS closes,
          COALESCE(SUM(
            CASE
              WHEN e.stage = 'checkout_paid' THEN
                CASE
                  WHEN json_extract(e.payload_json, '$.amount_usd') IS NOT NULL
                    THEN CAST(json_extract(e.payload_json, '$.amount_usd') AS REAL)
                  WHEN json_extract(e.payload_json, '$.amount') IS NOT NULL
                    THEN CAST(json_extract(e.payload_json, '$.amount') AS REAL) / 100.0
                  ELSE 0.0
                END
              ELSE 0.0
            END
          ), 0) AS gross_revenue_usd,
          COALESCE(SUM(
            CASE
              WHEN e.stage IN ({refund_placeholders}) THEN
                CASE
                  WHEN json_extract(e.payload_json, '$.refund_amount_usd') IS NOT NULL
                    THEN CAST(json_extract(e.payload_json, '$.refund_amount_usd') AS REAL)
                  WHEN json_extract(e.payload_json, '$.amount') IS NOT NULL
                    THEN CAST(json_extract(e.payload_json, '$.amount') AS REAL) / 100.0
                  ELSE 0.0
                END
              ELSE 0.0
            END
          ), 0) AS refunds_usd
        FROM attribution_events e
        JOIN attribution_chains c ON c.chain_id = e.chain_id
        WHERE c.brand = ?
          AND e.ts >= ?
          AND e.ts <= ?
        GROUP BY c.combo_id
        """
        out: dict[str, LedgerComboRevenueStats] = {}
        try:
            rows = self.conn.execute(
                sql, [*_REFUND_STAGES, brand, since_ts, until_ts]
            ).fetchall()
            for r in rows:
                combo_id = str(r[0]) if not isinstance(r, sqlite3.Row) else str(r["combo_id"])
                closes = int(r[1] if not isinstance(r, sqlite3.Row) else r["closes"]) or 0
                gross = float(r[2] if not isinstance(r, sqlite3.Row) else r["gross_revenue_usd"]) or 0.0
                refunds = float(r[3] if not isinstance(r, sqlite3.Row) else r["refunds_usd"]) or 0.0
                out[combo_id] = LedgerComboRevenueStats(
                    closes=closes,
                    gross_revenue_usd=gross,
                    refunds_usd=refunds,
                )
        except Exception:
            log.warning("get_revenue_by_combo_error", extra={"brand": brand}, exc_info=True)
        return out
