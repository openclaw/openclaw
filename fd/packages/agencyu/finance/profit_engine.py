"""Profit Engine — contribution margins, CAC cohorts, LTV:CAC, payback periods.

Provides financial dashboard data that AgencyU emphasizes:
  - Net margin per brand
  - CAC by acquisition cohort
  - LTV:CAC by offer
  - 90-day payback per campaign
  - Fulfillment cost per client
  - Team utilization cost mapping
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.finance.profit_engine")


# ── Data models ──


@dataclass(frozen=True)
class BrandMargin:
    """Net margin summary for a single brand."""

    brand: str
    gross_revenue_cents: int
    ad_spend_cents: int
    fulfillment_cost_cents: int
    team_cost_cents: int
    net_revenue_cents: int
    margin_pct: float  # 0-100
    period_label: str


@dataclass(frozen=True)
class CohortCAC:
    """CAC for a specific acquisition cohort."""

    cohort_month: str  # YYYY-MM
    brand: str
    ad_spend_cents: int
    new_customers: int
    cac_cents: int
    avg_deal_size_cents: int
    ltv_estimate_cents: int
    ltv_cac_ratio: float
    payback_days: int


@dataclass(frozen=True)
class OfferEconomics:
    """Unit economics for a specific offer."""

    offer_id: str
    brand: str
    customers: int
    total_revenue_cents: int
    total_ad_spend_cents: int
    avg_revenue_cents: int
    cac_cents: int
    est_ltv_cents: int
    ltv_cac_ratio: float
    contribution_margin_pct: float


@dataclass
class ProfitReport:
    """Full financial dashboard report."""

    brand_margins: list[BrandMargin] = field(default_factory=list)
    cohort_cacs: list[CohortCAC] = field(default_factory=list)
    offer_economics: list[OfferEconomics] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    generated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "brand_margins": [
                {
                    "brand": m.brand,
                    "gross_revenue": m.gross_revenue_cents,
                    "ad_spend": m.ad_spend_cents,
                    "fulfillment_cost": m.fulfillment_cost_cents,
                    "team_cost": m.team_cost_cents,
                    "net_revenue": m.net_revenue_cents,
                    "margin_pct": m.margin_pct,
                    "period": m.period_label,
                }
                for m in self.brand_margins
            ],
            "cohort_cacs": [
                {
                    "cohort": c.cohort_month,
                    "brand": c.brand,
                    "ad_spend": c.ad_spend_cents,
                    "new_customers": c.new_customers,
                    "cac": c.cac_cents,
                    "ltv_cac": c.ltv_cac_ratio,
                    "payback_days": c.payback_days,
                }
                for c in self.cohort_cacs
            ],
            "offer_economics": [
                {
                    "offer_id": o.offer_id,
                    "brand": o.brand,
                    "customers": o.customers,
                    "total_revenue": o.total_revenue_cents,
                    "cac": o.cac_cents,
                    "ltv_cac": o.ltv_cac_ratio,
                    "contribution_margin_pct": o.contribution_margin_pct,
                }
                for o in self.offer_economics
            ],
            "summary": self.summary,
            "generated_at": self.generated_at,
        }


# ── Default cost assumptions (cents) ──

# Fulfillment cost per client per month (team labor + tools)
_DEFAULT_FULFILLMENT_COST_PER_CLIENT = 80_000  # $800/mo FD
_DEFAULT_FULFILLMENT_COST_CUTMV = 5_000  # $50/mo CUTMV (infra only)

# Team cost per member per month
_DEFAULT_TEAM_COST_PER_MEMBER = 500_000  # $5k/mo average

# Default retention for LTV estimation
_DEFAULT_RETENTION_MONTHS_FD = 6.0
_DEFAULT_RETENTION_MONTHS_CUTMV = 8.0


def compute_brand_margins(
    conn: sqlite3.Connection,
    *,
    window_days: int = 30,
) -> list[BrandMargin]:
    """Compute net margin per brand for the given window.

    Revenue: from revenue_attribution
    Ad spend: from campaign_integrity or mv_combo_daily
    Fulfillment: estimated from active client count
    Team: from team_capacity_v2 member count
    """
    since = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    period = f"last_{window_days}d"
    margins: list[BrandMargin] = []

    for brand in ("fulldigital", "cutmv"):
        # Revenue
        try:
            rev_row = conn.execute(
                """SELECT COALESCE(SUM(amount_cents), 0) AS total
                   FROM revenue_attribution
                   WHERE brand = ? AND ts >= ?""",
                (brand, since),
            ).fetchone()
            gross_revenue = int(rev_row["total"] or 0)
        except Exception:
            gross_revenue = 0

        # Ad spend
        try:
            spend_row = conn.execute(
                """SELECT COALESCE(SUM(spend_cents), 0) AS total
                   FROM mv_combo_daily
                   WHERE brand = ? AND day >= ?""",
                (brand, since[:10]),
            ).fetchone()
            ad_spend = int(spend_row["total"] or 0)
        except Exception:
            ad_spend = 0

        # Active clients (for fulfillment cost estimate)
        try:
            client_row = conn.execute(
                """SELECT COUNT(DISTINCT contact_key) AS cnt
                   FROM lead_attribution
                   WHERE brand = ? AND primary_stage IN ('closed_won', 'checkout_paid')""",
                (brand,),
            ).fetchone()
            active_clients = int(client_row["cnt"] or 0)
        except Exception:
            active_clients = 0

        cost_per_client = (
            _DEFAULT_FULFILLMENT_COST_CUTMV if brand == "cutmv"
            else _DEFAULT_FULFILLMENT_COST_PER_CLIENT
        )
        fulfillment_cost = active_clients * cost_per_client

        # Team cost
        try:
            team_row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM team_capacity_v2 WHERE enabled=1"
            ).fetchone()
            team_count = int(team_row["cnt"] or 0)
        except Exception:
            team_count = 0

        # Split team cost by brand (proportional to revenue)
        team_cost = (team_count * _DEFAULT_TEAM_COST_PER_MEMBER) // 2  # Split evenly for now

        net = gross_revenue - ad_spend - fulfillment_cost - team_cost
        margin_pct = round((net / max(1, gross_revenue)) * 100, 1)

        margins.append(BrandMargin(
            brand=brand,
            gross_revenue_cents=gross_revenue,
            ad_spend_cents=ad_spend,
            fulfillment_cost_cents=fulfillment_cost,
            team_cost_cents=team_cost,
            net_revenue_cents=net,
            margin_pct=margin_pct,
            period_label=period,
        ))

    return margins


def compute_cohort_cacs(
    conn: sqlite3.Connection,
    *,
    lookback_months: int = 6,
) -> list[CohortCAC]:
    """Compute CAC by monthly acquisition cohort.

    Groups new customers by the month of their first touch,
    attributes ad spend from that period.
    """
    cohorts: list[CohortCAC] = []
    now = datetime.now(UTC)

    for i in range(lookback_months):
        month_start = (now - timedelta(days=30 * (i + 1))).replace(day=1)
        month_end = (now - timedelta(days=30 * i)).replace(day=1)
        month_label = month_start.strftime("%Y-%m")
        ms_str = month_start.isoformat()
        me_str = month_end.isoformat()

        for brand in ("fulldigital", "cutmv"):
            try:
                # New customers in this cohort
                cust_row = conn.execute(
                    """SELECT COUNT(DISTINCT contact_key) AS cnt,
                              COALESCE(AVG(amount_cents), 0) AS avg_deal
                       FROM (
                           SELECT la.contact_key, ra.amount_cents
                           FROM lead_attribution la
                           LEFT JOIN revenue_attribution ra ON ra.contact_key = la.contact_key
                           WHERE la.brand = ?
                               AND la.first_touch_ts >= ? AND la.first_touch_ts < ?
                               AND la.primary_stage IN ('closed_won', 'checkout_paid')
                       )""",
                    (brand, ms_str, me_str),
                ).fetchone()
                new_customers = int(cust_row["cnt"] or 0)
                avg_deal = int(cust_row["avg_deal"] or 0)
            except Exception:
                new_customers = 0
                avg_deal = 0

            try:
                spend_row = conn.execute(
                    """SELECT COALESCE(SUM(spend_cents), 0) AS total
                       FROM mv_combo_daily
                       WHERE brand = ? AND day >= ? AND day < ?""",
                    (brand, month_label + "-01", month_end.strftime("%Y-%m-%d")),
                ).fetchone()
                ad_spend = int(spend_row["total"] or 0)
            except Exception:
                ad_spend = 0

            cac = ad_spend // max(1, new_customers)
            retention = (
                _DEFAULT_RETENTION_MONTHS_CUTMV if brand == "cutmv"
                else _DEFAULT_RETENTION_MONTHS_FD
            )
            ltv_est = int(avg_deal * retention)
            ltv_cac = round(ltv_est / max(1, cac), 2)

            # Payback: months to recover CAC from avg monthly revenue
            monthly_rev = avg_deal  # Approximation: deal size ≈ first month
            payback_days = int((cac / max(1, monthly_rev)) * 30) if monthly_rev > 0 else 365

            cohorts.append(CohortCAC(
                cohort_month=month_label,
                brand=brand,
                ad_spend_cents=ad_spend,
                new_customers=new_customers,
                cac_cents=cac,
                avg_deal_size_cents=avg_deal,
                ltv_estimate_cents=ltv_est,
                ltv_cac_ratio=ltv_cac,
                payback_days=payback_days,
            ))

    return cohorts


def compute_offer_economics(
    conn: sqlite3.Connection,
) -> list[OfferEconomics]:
    """Compute unit economics per offer from campaign_integrity + revenue data.

    Maps utm_campaign → offer_id for reporting.
    """
    economics: list[OfferEconomics] = []

    try:
        rows = conn.execute(
            """SELECT
                utm_campaign,
                brand,
                closed_won,
                ad_spend_cents,
                COALESCE(total_revenue_cents, 0) AS total_revenue,
                close_rate
            FROM campaign_integrity
            WHERE closed_won > 0
            ORDER BY total_revenue_cents DESC"""
        ).fetchall()
    except Exception:
        log.debug("offer_economics_query_error", exc_info=True)
        return economics

    for r in rows:
        customers = int(r["closed_won"] or 0)
        revenue = int(r["total_revenue"] or 0)
        spend = int(r["ad_spend_cents"] or 0)
        brand = r["brand"] or "fulldigital"

        if customers == 0:
            continue

        avg_rev = revenue // customers
        cac = spend // customers if customers > 0 else 0
        retention = (
            _DEFAULT_RETENTION_MONTHS_CUTMV if brand == "cutmv"
            else _DEFAULT_RETENTION_MONTHS_FD
        )
        ltv = int(avg_rev * retention)
        ltv_cac = round(ltv / max(1, cac), 2)

        # Contribution margin: revenue - spend / revenue
        contribution = round(((revenue - spend) / max(1, revenue)) * 100, 1)

        economics.append(OfferEconomics(
            offer_id=r["utm_campaign"],
            brand=brand,
            customers=customers,
            total_revenue_cents=revenue,
            total_ad_spend_cents=spend,
            avg_revenue_cents=avg_rev,
            cac_cents=cac,
            est_ltv_cents=ltv,
            ltv_cac_ratio=ltv_cac,
            contribution_margin_pct=contribution,
        ))

    return economics


def run_profit_report(
    conn: sqlite3.Connection,
    *,
    window_days: int = 30,
    lookback_months: int = 6,
) -> ProfitReport:
    """Generate the full financial dashboard report.

    Combines brand margins, cohort CACs, and offer economics.
    """
    margins = compute_brand_margins(conn, window_days=window_days)
    cohorts = compute_cohort_cacs(conn, lookback_months=lookback_months)
    offers = compute_offer_economics(conn)

    # Summary
    total_rev = sum(m.gross_revenue_cents for m in margins)
    total_spend = sum(m.ad_spend_cents for m in margins)
    total_net = sum(m.net_revenue_cents for m in margins)
    blended_margin = round((total_net / max(1, total_rev)) * 100, 1)

    # Best/worst cohort by LTV:CAC
    active_cohorts = [c for c in cohorts if c.new_customers > 0]
    best_cohort = max(active_cohorts, key=lambda c: c.ltv_cac_ratio) if active_cohorts else None
    worst_cohort = min(active_cohorts, key=lambda c: c.ltv_cac_ratio) if active_cohorts else None

    summary: dict[str, Any] = {
        "total_revenue_cents": total_rev,
        "total_ad_spend_cents": total_spend,
        "total_net_revenue_cents": total_net,
        "blended_margin_pct": blended_margin,
        "best_cohort": best_cohort.cohort_month if best_cohort else None,
        "worst_cohort": worst_cohort.cohort_month if worst_cohort else None,
        "offer_count": len(offers),
    }

    report = ProfitReport(
        brand_margins=margins,
        cohort_cacs=cohorts,
        offer_economics=offers,
        summary=summary,
        generated_at=datetime.now(UTC).isoformat(),
    )

    log.info("profit_report_generated", extra={
        "total_revenue": total_rev,
        "blended_margin": blended_margin,
        "cohort_count": len(cohorts),
    })

    return report
