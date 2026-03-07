"""Metrics Aggregator — Joins Meta Insights + Attribution Ledger into ComboMetrics.

This is the production binding that makes the experiment policy actionable.
It pulls ad performance from Meta Graph API and joins it with conversion/revenue
data from the attribution ledger (which tracks Stripe payments + funnel stages).

Data flow:
  Meta Insights API  →  CTR, CPM, frequency, spend, impressions, clicks
  Attribution Ledger →  conversions (primary event per brand), revenue (Stripe)
  Combined           →  ComboMetrics for the policy engine

Dual conversion model (Full Digital):
  Pipeline conversion: booking_complete / application_submit → optimizes lead quality
  Revenue conversion:  checkout_paid (Stripe)               → optimizes actual sales + LTV:CAC

Combo ID convention: include 'combo:<id>' or 'combo_id=<id>' in
campaign/adset/ad names so the aggregator can group by combo.
"""
from __future__ import annotations

import datetime
import json
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from packages.agencyu.integrations.meta_insights import MetaInsightsClient
from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.agencyu.marketing.ledger_metrics import LedgerMetrics
from packages.agencyu.marketing.metrics_types import ComboMetrics, ComboMetricsFD
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.metrics_aggregator")


def extract_combo_id_from_name(name: str) -> str | None:
    """Extract combo_id from ad/adset/campaign name.

    Convention: include 'combo:<id>' or 'combo_id=<id>' in the name.
    """
    if not name:
        return None
    for token in name.replace("=", " ").replace(":", " combo:").split():
        if token.startswith("combo:"):
            val = token.split("combo:", 1)[1].strip()
            if val:
                return val
    # Fallback: check for 'combo_id=<id>' pattern
    if "combo_id=" in name:
        idx = name.index("combo_id=") + len("combo_id=")
        end = name.find(" ", idx)
        return name[idx:end] if end != -1 else name[idx:]
    return None


@dataclass
class AggregatorConfig:
    """Configuration for a single aggregation run."""

    brand: str
    since: str  # YYYY-MM-DD
    until: str  # YYYY-MM-DD
    conversion_events: list[str] | None = None


class MetricsAggregator:
    """Aggregates Meta ad insights + attribution ledger into ComboMetrics.

    Supports dual conversion tracking:
    - Pipeline conversions (booking_complete, application_submit for FD)
    - Revenue conversions (checkout_paid → Stripe)

    Args:
        meta: MetaInsightsClient for fetching ad performance.
        ledger: AttributionLedger for querying conversions and revenue.
        policy: Experiment policy dict (used for brand conversion definitions).
    """

    def __init__(
        self,
        *,
        meta: MetaInsightsClient,
        ledger: AttributionLedger,
        policy: dict[str, Any] | None = None,
    ) -> None:
        self.meta = meta
        self.ledger = ledger
        self.policy = policy or {}

    def _resolve_brand_conversions(self, brand: str) -> dict[str, Any]:
        """Resolve conversion config for a brand from policy definitions."""
        defs = self.policy.get("definitions", {}).get("brand_conversions", {})
        return defs.get(brand, {})

    def aggregate(self, cfg: AggregatorConfig) -> list[ComboMetrics]:
        """Pull Meta insights, join with ledger data, return ComboMetrics.

        Computes dual conversion counts:
        - conversions: primary conversion events (used for CPA)
        - pipeline_conversions: all pipeline-stage events (FD: booking + application)
        - revenue_conversions: count of Stripe payment events
        """
        raw = self.meta.fetch_ad_insights(
            since=cfg.since,
            until=cfg.until,
            level="ad",
        )
        if "error" in raw:
            log.warning(
                "meta_insights_error",
                extra={"brand": cfg.brand, "error": raw["error"]},
            )
            return []

        rows = raw.get("data", [])
        if not rows:
            return []

        # Aggregate Meta stats by combo_id
        meta_by_combo: dict[str, dict[str, float]] = defaultdict(
            lambda: {
                "impressions": 0,
                "clicks": 0,
                "spend": 0.0,
                "ctr_sum": 0.0,
                "cpm_sum": 0.0,
                "frequency_sum": 0.0,
                "_rows": 0,
            }
        )

        for r in rows:
            combo_id = (
                extract_combo_id_from_name(r.get("ad_name", ""))
                or extract_combo_id_from_name(r.get("adset_name", ""))
                or extract_combo_id_from_name(r.get("campaign_name", ""))
            )
            if not combo_id:
                continue

            bucket = meta_by_combo[combo_id]
            bucket["impressions"] += int(float(r.get("impressions", 0) or 0))
            bucket["clicks"] += int(float(r.get("clicks", 0) or 0))
            bucket["spend"] += float(r.get("spend", 0) or 0)
            bucket["ctr_sum"] += float(r.get("ctr", 0) or 0)
            bucket["cpm_sum"] += float(r.get("cpm", 0) or 0)
            bucket["frequency_sum"] += float(r.get("frequency", 0) or 0)
            bucket["_rows"] += 1

        # Resolve conversion definitions for this brand
        brand_conv = self._resolve_brand_conversions(cfg.brand)

        # Primary conversion stages (used for CPA computation)
        primary_stages = cfg.conversion_events
        if not primary_stages:
            primary = brand_conv.get("primary")
            primary_stages = [primary] if primary else []

        # Pipeline stages (FD: booking_complete + application_submit)
        pipeline_stages = brand_conv.get("pipeline_stages") or primary_stages

        # Revenue stage (Stripe paid)
        revenue_stage = brand_conv.get("revenue_stage", "checkout_paid")

        # ISO timestamp boundaries for windowed queries
        since_ts = f"{cfg.since}T00:00:00"
        until_ts = f"{cfg.until}T23:59:59"

        # Build ComboMetrics by joining Meta stats + ledger conversions/revenue
        # For fulldigital: emit ComboMetricsFD with dual-conversion analytics
        # For other brands: emit base ComboMetrics
        is_fd = cfg.brand == "fulldigital"

        # Pre-compute standardized ledger metrics (batch queries)
        ledger_std = LedgerMetrics(self.ledger.conn)
        call_stats = ledger_std.get_calls_by_combo(cfg.brand, since_ts, until_ts) if is_fd else {}
        rev_stats = ledger_std.get_revenue_by_combo(cfg.brand, since_ts, until_ts) if is_fd else {}

        out: list[ComboMetrics] = []
        for combo_id, m in meta_by_combo.items():
            rows_n = max(1, int(m["_rows"]))
            ctr = m["ctr_sum"] / rows_n
            cpm = m["cpm_sum"] / rows_n
            freq = m["frequency_sum"] / rows_n
            spend = float(m["spend"])

            revenue_conv = self.count_conversions(
                cfg.brand, combo_id, [revenue_stage], since_ts, until_ts,
            )
            revenue = self.sum_revenue(
                cfg.brand, combo_id, since_ts, until_ts, revenue_stage,
            )
            roas = (revenue / spend) if spend > 0 else 0.0

            if is_fd:
                # Full Digital: separate pipeline vs revenue conversions
                bookings = self.count_conversions(
                    cfg.brand, combo_id, ["booking_complete"], since_ts, until_ts,
                )
                apps = self.count_conversions(
                    cfg.brand, combo_id, ["application_submit"], since_ts, until_ts,
                )
                pipeline_conv = bookings + apps

                # Policy engine sees pipeline as primary conversion
                conversions = pipeline_conv
                pipeline_cpa = (spend / pipeline_conv) if pipeline_conv > 0 else (spend if spend > 0 else 0.0)
                cpa = pipeline_cpa

                # Standardized ledger stats: calls_observed = showed else booked
                combo_calls = call_stats.get(combo_id)
                if combo_calls:
                    calls_observed = combo_calls.calls_observed
                    attended = combo_calls.calls_showed
                else:
                    calls_observed = bookings  # fallback
                    attended = self.count_conversions(
                        cfg.brand, combo_id,
                        ["call_showed", "appointment_attended", "call_attended"],
                        since_ts, until_ts,
                    )

                # Standardized ledger stats: closes + net revenue (refunds excluded)
                combo_rev = rev_stats.get(combo_id)
                if combo_rev:
                    revenue_conv = combo_rev.closes
                    revenue = combo_rev.net_revenue_usd
                # else keep revenue_conv/revenue from per-combo queries above

                rev_cpa = (spend / revenue_conv) if revenue_conv > 0 else (spend if spend > 0 else 0.0)
                close_rate = (revenue_conv / calls_observed) if calls_observed > 0 else 0.0
                show_rate = (attended / bookings) if bookings > 0 else 0.0
                roas = (revenue / spend) if spend > 0 else 0.0

                # Quality signal fields
                qualified_count = self.count_qualified(
                    cfg.brand, combo_id, since_ts, until_ts,
                )
                qualified_rate = (
                    (qualified_count / pipeline_conv) if pipeline_conv > 0 else 0.0
                )
                avg_lead_score_val = self.avg_lead_score(
                    cfg.brand, combo_id, since_ts, until_ts,
                )

                out.append(
                    ComboMetricsFD(
                        combo_id=combo_id,
                        brand=cfg.brand,
                        impressions=int(m["impressions"]),
                        clicks=int(m["clicks"]),
                        conversions=int(conversions),
                        spend_usd=spend,
                        revenue_usd=float(revenue),
                        ctr=float(ctr),
                        cpm=float(cpm),
                        frequency=float(freq),
                        cpa=float(cpa),
                        roas=float(roas),
                        pipeline_conversions=int(pipeline_conv),
                        revenue_conversions=int(revenue_conv),
                        pipeline_cpa=float(pipeline_cpa),
                        revenue_cpa=float(rev_cpa),
                        close_rate=float(close_rate),
                        bookings=int(bookings),
                        application_submits=int(apps),
                        attended_calls=int(attended),
                        show_rate=float(show_rate),
                        calls_observed=int(calls_observed),
                        qualified_count=int(qualified_count),
                        qualified_rate=float(qualified_rate),
                        avg_lead_score=avg_lead_score_val,
                    )
                )
            else:
                # CUTMV (and any other brand): standard ComboMetrics
                conversions = self.count_conversions(
                    cfg.brand, combo_id, primary_stages, since_ts, until_ts,
                )
                pipeline_conv = self.count_conversions(
                    cfg.brand, combo_id, pipeline_stages, since_ts, until_ts,
                )
                cpa = (spend / conversions) if conversions > 0 else (spend if spend > 0 else 0.0)

                out.append(
                    ComboMetrics(
                        combo_id=combo_id,
                        brand=cfg.brand,
                        impressions=int(m["impressions"]),
                        clicks=int(m["clicks"]),
                        conversions=int(conversions),
                        spend_usd=spend,
                        revenue_usd=float(revenue),
                        ctr=float(ctr),
                        cpm=float(cpm),
                        frequency=float(freq),
                        cpa=float(cpa),
                        roas=float(roas),
                        pipeline_conversions=int(pipeline_conv),
                        revenue_conversions=int(revenue_conv),
                    )
                )

        log.info(
            "aggregation_complete",
            extra={"brand": cfg.brand, "combos": len(out)},
        )
        return out

    def count_conversions(
        self,
        brand: str,
        combo_id: str,
        stages: list[str],
        since_ts: str,
        until_ts: str,
    ) -> int:
        """Count conversion events within a time window.

        Uses windowed SQL: brand + combo_id + stage IN (...) + ts range.
        """
        if not stages:
            return 0

        try:
            placeholders = ",".join("?" * len(stages))
            row = self.ledger.conn.execute(
                f"""SELECT COUNT(*)
                FROM attribution_events e
                JOIN attribution_chains c ON c.chain_id = e.chain_id
                WHERE c.brand = ?
                  AND c.combo_id = ?
                  AND e.ts >= ?
                  AND e.ts <= ?
                  AND e.stage IN ({placeholders})""",
                [brand, combo_id, since_ts, until_ts, *stages],
            ).fetchone()
            return int(row[0]) if row else 0
        except Exception:
            log.warning(
                "count_conversions_error",
                extra={"brand": brand, "combo_id": combo_id},
                exc_info=True,
            )
            return 0

    def count_qualified(
        self,
        brand: str,
        combo_id: str,
        since_ts: str,
        until_ts: str,
    ) -> int:
        """Count pipeline conversions tagged as qualified."""
        try:
            row = self.ledger.conn.execute(
                """SELECT COUNT(*)
                FROM attribution_events e
                JOIN attribution_chains c ON c.chain_id = e.chain_id
                WHERE c.brand = ?
                  AND c.combo_id = ?
                  AND e.ts >= ?
                  AND e.ts <= ?
                  AND e.stage IN ('booking_complete', 'application_submit')
                  AND json_extract(e.payload_json, '$.qualified') = 1""",
                (brand, combo_id, since_ts, until_ts),
            ).fetchone()
            return int(row[0]) if row else 0
        except Exception:
            log.warning(
                "count_qualified_error",
                extra={"brand": brand, "combo_id": combo_id},
                exc_info=True,
            )
            return 0

    def avg_lead_score(
        self,
        brand: str,
        combo_id: str,
        since_ts: str,
        until_ts: str,
    ) -> float | None:
        """Average lead score across pipeline conversions."""
        try:
            row = self.ledger.conn.execute(
                """SELECT AVG(CAST(json_extract(e.payload_json, '$.lead_score') AS REAL))
                FROM attribution_events e
                JOIN attribution_chains c ON c.chain_id = e.chain_id
                WHERE c.brand = ?
                  AND c.combo_id = ?
                  AND e.ts >= ?
                  AND e.ts <= ?
                  AND e.stage IN ('booking_complete', 'application_submit')
                  AND json_extract(e.payload_json, '$.lead_score') IS NOT NULL""",
                (brand, combo_id, since_ts, until_ts),
            ).fetchone()
            return float(row[0]) if row and row[0] is not None else None
        except Exception:
            log.warning(
                "avg_lead_score_error",
                extra={"brand": brand, "combo_id": combo_id},
                exc_info=True,
            )
            return None

    def sum_revenue(
        self,
        brand: str,
        combo_id: str,
        since_ts: str,
        until_ts: str,
        revenue_stage: str = "checkout_paid",
    ) -> float:
        """Sum revenue from payment events within a time window.

        Uses amount_usd if present in payload, falls back to amount/100
        (cents to dollars) if amount_usd is missing.
        """
        try:
            row = self.ledger.conn.execute(
                """SELECT COALESCE(SUM(
                    CASE
                      WHEN json_extract(e.payload_json, '$.amount_usd') IS NOT NULL
                        THEN CAST(json_extract(e.payload_json, '$.amount_usd') AS REAL)
                      WHEN json_extract(e.payload_json, '$.amount') IS NOT NULL
                        THEN CAST(json_extract(e.payload_json, '$.amount') AS REAL) / 100.0
                      ELSE 0.0
                    END
                  ), 0)
                FROM attribution_events e
                JOIN attribution_chains c ON c.chain_id = e.chain_id
                WHERE c.brand = ?
                  AND c.combo_id = ?
                  AND e.ts >= ?
                  AND e.ts <= ?
                  AND e.stage = ?""",
                (brand, combo_id, since_ts, until_ts, revenue_stage),
            ).fetchone()
            return float(row[0]) if row else 0.0
        except Exception:
            log.warning(
                "sum_revenue_error",
                extra={"brand": brand, "combo_id": combo_id},
                exc_info=True,
            )
            return 0.0


def compute_evaluation_window(window_hours: int) -> tuple[str, str]:
    """Compute (since, until) date strings for the evaluation window.

    Returns:
        (since_date, until_date) as YYYY-MM-DD strings.
    """
    now = datetime.datetime.utcnow()
    since = now - datetime.timedelta(hours=window_hours)
    return since.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")
