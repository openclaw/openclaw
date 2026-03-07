"""Unit Economics Engine — CAC, LTV, and capital efficiency metrics.

Computes and monitors:
- Customer Acquisition Cost (CAC)
- Lifetime Value (LTV)
- LTV/CAC ratio
- Per-campaign unit economics
- Capital preservation guardrails

Warns when:
- LTV/CAC < 2
- Close rate drops below 10%
- Retention dips under 3 months
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.unit_economics")


@dataclass(frozen=True)
class UnitEconomics:
    """Computed unit economics for a cohort or campaign."""
    cac_cents: int
    ltv_cents: int
    ltv_cac_ratio: float
    healthy: bool
    avg_monthly_revenue_cents: int
    avg_retention_months: float
    new_customers: int
    ad_spend_cents: int
    warnings: list[str]


# Default thresholds
MIN_LTV_CAC_RATIO = 3.0
WARNING_LTV_CAC_RATIO = 2.0
MIN_CLOSE_RATE = 0.10  # 10%
MIN_RETENTION_MONTHS = 3.0


def compute_unit_economics(
    metrics: dict[str, Any],
    *,
    min_ratio: float = MIN_LTV_CAC_RATIO,
    warning_ratio: float = WARNING_LTV_CAC_RATIO,
) -> UnitEconomics:
    """Compute unit economics from aggregate metrics.

    Args:
        metrics: Dict with keys:
            - ad_spend_cents: Total ad spend in cents
            - new_customers: Number of new customers acquired
            - avg_monthly_revenue_cents: Average revenue per customer per month (cents)
            - avg_retention_months: Average customer retention in months
            - close_rate: (optional) Close rate for warning calculation

    Returns:
        UnitEconomics with health assessment and warnings.
    """
    ad_spend = metrics.get("ad_spend_cents", 0)
    new_customers = metrics.get("new_customers", 0)
    avg_monthly_rev = metrics.get("avg_monthly_revenue_cents", 0)
    avg_retention = metrics.get("avg_retention_months", 0.0)
    close_rate = metrics.get("close_rate", None)

    # CAC
    cac = ad_spend // new_customers if new_customers > 0 else 0

    # LTV
    ltv = int(avg_monthly_rev * avg_retention) if avg_retention > 0 else 0

    # Ratio
    ratio = round(ltv / cac, 2) if cac > 0 else 0.0

    # Warnings
    warnings: list[str] = []
    if cac > 0 and ratio < warning_ratio:
        warnings.append(f"ltv_cac_ratio {ratio} < {warning_ratio}")
    if close_rate is not None and close_rate < MIN_CLOSE_RATE:
        warnings.append(f"close_rate {close_rate:.1%} < {MIN_CLOSE_RATE:.0%}")
    if avg_retention > 0 and avg_retention < MIN_RETENTION_MONTHS:
        warnings.append(f"avg_retention {avg_retention:.1f}mo < {MIN_RETENTION_MONTHS:.0f}mo")

    healthy = ratio >= min_ratio and not warnings

    return UnitEconomics(
        cac_cents=cac,
        ltv_cents=ltv,
        ltv_cac_ratio=ratio,
        healthy=healthy,
        avg_monthly_revenue_cents=avg_monthly_rev,
        avg_retention_months=avg_retention,
        new_customers=new_customers,
        ad_spend_cents=ad_spend,
        warnings=warnings,
    )


def compute_campaign_unit_economics(
    conn: sqlite3.Connection,
    utm_campaign: str,
    *,
    avg_monthly_revenue_cents: int = 300_000,  # $3k default
    avg_retention_months: float = 6.0,  # 6 months default
) -> UnitEconomics | None:
    """Compute unit economics for a specific campaign from DB data.

    Pulls ad spend and customer count from campaign_integrity table.
    """
    row = conn.execute(
        "SELECT ad_spend_cents, closed_won, total_leads, close_rate FROM campaign_integrity WHERE utm_campaign=?",
        (utm_campaign,),
    ).fetchone()

    if not row:
        return None

    return compute_unit_economics({
        "ad_spend_cents": row["ad_spend_cents"] or 0,
        "new_customers": row["closed_won"] or 0,
        "avg_monthly_revenue_cents": avg_monthly_revenue_cents,
        "avg_retention_months": avg_retention_months,
        "close_rate": row["close_rate"] or 0.0,
    })


def should_preserve_capital(economics: UnitEconomics) -> dict[str, Any]:
    """Check if capital preservation guardrails should trigger.

    Pause campaigns if:
    - CAC > LTV/3
    - Close rate warnings present
    - LTV/CAC < 2
    """
    should_pause = False
    reasons: list[str] = []

    if economics.cac_cents > 0 and economics.ltv_cents > 0:
        max_cac = economics.ltv_cents // 3
        if economics.cac_cents > max_cac:
            should_pause = True
            reasons.append(f"cac ${economics.cac_cents/100:.0f} > ltv/3 ${max_cac/100:.0f}")

    if economics.ltv_cac_ratio > 0 and economics.ltv_cac_ratio < 2.0:
        should_pause = True
        reasons.append(f"ltv_cac_ratio {economics.ltv_cac_ratio} < 2.0")

    for w in economics.warnings:
        if "close_rate" in w:
            should_pause = True
            reasons.append(w)

    return {
        "should_pause": should_pause,
        "reasons": reasons,
        "economics": {
            "cac_cents": economics.cac_cents,
            "ltv_cents": economics.ltv_cents,
            "ltv_cac_ratio": economics.ltv_cac_ratio,
        },
    }


def revenue_forecast(
    *,
    booked_calls: int,
    historical_close_rate: float,
    avg_deal_size_cents: int,
    current_mrr_cents: int = 0,
    pipeline_value_cents: int = 0,
) -> dict[str, Any]:
    """Forecast 30/90 day revenue from current pipeline.

    Args:
        booked_calls: Number of calls booked (next 30 days).
        historical_close_rate: Historical close rate (0-1).
        avg_deal_size_cents: Average deal size in cents.
        current_mrr_cents: Current MRR in cents.
        pipeline_value_cents: Total pipeline value in cents.
    """
    projected_new_30d = int(booked_calls * historical_close_rate * avg_deal_size_cents)
    projected_30d = current_mrr_cents + projected_new_30d
    projected_90d = (current_mrr_cents * 3) + (projected_new_30d * 2)  # Conservative: 2x new for 90d

    return {
        "forecast_30d_cents": projected_30d,
        "forecast_90d_cents": projected_90d,
        "projected_new_revenue_30d_cents": projected_new_30d,
        "current_mrr_cents": current_mrr_cents,
        "pipeline_value_cents": pipeline_value_cents,
        "booked_calls": booked_calls,
        "assumed_close_rate": historical_close_rate,
        "assumed_deal_size_cents": avg_deal_size_cents,
    }
