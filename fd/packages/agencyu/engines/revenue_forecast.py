"""Revenue Forecast Engine — Monte Carlo simulation for revenue projection.

Full Digital LLC — CUTMV + Full Digital.
1000-iteration Monte Carlo with 3 scenarios per brand (conservative/moderate/aggressive).
Projects 30/60/90 days with 90% confidence intervals.

Outputs:
- Revenue projections with confidence intervals
- Break-even analysis
- Scenario comparisons
"""
from __future__ import annotations

import random
import statistics
from dataclasses import dataclass, field
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.engines.revenue_forecast")


@dataclass
class FunnelMetrics:
    """Real or estimated funnel conversion rates."""

    brand: str
    daily_ad_spend: float = 50.0
    cost_per_impression: float = 0.008
    impression_to_comment_rate: float = 0.005
    comment_to_dm_rate: float = 0.85
    dm_to_qualified_rate: float = 0.60
    qualified_to_action_rate: float = 0.40
    # CUTMV: signup → paid
    signup_to_paid_rate: float = 0.15
    avg_revenue_per_conversion: float = 49.0
    monthly_churn_rate: float = 0.08
    # Full Digital: booked → show → close
    booked_to_show_rate: float = 0.70
    show_to_close_rate: float = 0.25
    avg_deal_value: float = 5000.0
    avg_client_lifetime_months: float = 6.0


@dataclass(frozen=True)
class ForecastResult:
    """Output of a single forecast run."""

    brand: str
    scenario: str
    period_days: int
    total_spend: float
    total_revenue: float
    net_profit: float
    roi: float
    new_customers: int
    mrr_end: float
    break_even_day: int | None
    confidence_interval: tuple[float, float] = (0.0, 0.0)


class RevenueForecastEngine:
    """Monte Carlo revenue forecast engine."""

    def __init__(self, simulations: int = 1000) -> None:
        self.simulations = simulations

    def _variance(self, v: float) -> float:
        return v * random.uniform(0.8, 1.2)

    def _simulate_day_cutmv(self, metrics: FunnelMetrics, existing_mrr: float) -> dict[str, Any]:
        impressions = metrics.daily_ad_spend / self._variance(metrics.cost_per_impression)
        comments = impressions * self._variance(metrics.impression_to_comment_rate)
        dms = comments * self._variance(metrics.comment_to_dm_rate)
        qualified = dms * self._variance(metrics.dm_to_qualified_rate)
        signups = qualified * self._variance(metrics.qualified_to_action_rate)
        paid = signups * self._variance(metrics.signup_to_paid_rate)
        new_mrr = paid * metrics.avg_revenue_per_conversion
        churn_loss = existing_mrr * (metrics.monthly_churn_rate / 30)
        end_mrr = max(0, existing_mrr + new_mrr - churn_loss)
        return {
            "spend": metrics.daily_ad_spend,
            "paid": int(paid),
            "new_mrr": new_mrr,
            "churn_loss": churn_loss,
            "end_mrr": end_mrr,
            "daily_revenue": end_mrr / 30,
        }

    def _simulate_day_fulldigital(self, metrics: FunnelMetrics, existing_mrr: float) -> dict[str, Any]:
        impressions = metrics.daily_ad_spend / self._variance(metrics.cost_per_impression)
        comments = impressions * self._variance(metrics.impression_to_comment_rate)
        dms = comments * self._variance(metrics.comment_to_dm_rate)
        qualified = dms * self._variance(metrics.dm_to_qualified_rate)
        booked = qualified * self._variance(metrics.qualified_to_action_rate)
        showed = booked * self._variance(metrics.booked_to_show_rate)
        closed = showed * self._variance(metrics.show_to_close_rate)
        new_mrr = closed * metrics.avg_deal_value
        churn_loss = existing_mrr * (metrics.monthly_churn_rate / 30)
        end_mrr = max(0, existing_mrr + new_mrr - churn_loss)
        return {
            "spend": metrics.daily_ad_spend,
            "closed_deals": int(closed),
            "new_mrr": new_mrr,
            "churn_loss": churn_loss,
            "end_mrr": end_mrr,
            "daily_revenue": end_mrr / 30,
        }

    def run_forecast(
        self,
        metrics: FunnelMetrics,
        period_days: int = 90,
        starting_mrr: float = 0.0,
        scenario_name: str = "moderate",
    ) -> ForecastResult:
        """Run a Monte Carlo forecast simulation."""
        final_revenues: list[float] = []
        final_mrrs: list[float] = []
        final_customers: list[int] = []
        break_even_days: list[int | None] = []

        sim_fn = self._simulate_day_cutmv if metrics.brand == "cutmv" else self._simulate_day_fulldigital
        customer_key = "paid" if metrics.brand == "cutmv" else "closed_deals"

        for _ in range(self.simulations):
            total_spend = 0.0
            total_revenue = 0.0
            mrr = starting_mrr
            new_customers = 0
            be_found = False

            for day in range(period_days):
                result = sim_fn(metrics, mrr)
                total_spend += result["spend"]
                mrr = result["end_mrr"]
                total_revenue += result["daily_revenue"]
                new_customers += result.get(customer_key, 0)

                if not be_found and total_revenue >= total_spend:
                    break_even_days.append(day + 1)
                    be_found = True

            if not be_found:
                break_even_days.append(None)

            final_revenues.append(total_revenue)
            final_mrrs.append(mrr)
            final_customers.append(new_customers)

        revenues_sorted = sorted(final_revenues)
        ci_low = revenues_sorted[int(self.simulations * 0.05)]
        ci_high = revenues_sorted[int(self.simulations * 0.95)]
        median_revenue = statistics.median(final_revenues)
        median_mrr = statistics.median(final_mrrs)
        median_customers = int(statistics.median(final_customers))
        total_spend = metrics.daily_ad_spend * period_days

        valid_be = [d for d in break_even_days if d is not None]
        median_be = int(statistics.median(valid_be)) if valid_be else None

        return ForecastResult(
            brand=metrics.brand,
            scenario=scenario_name,
            period_days=period_days,
            total_spend=round(total_spend, 2),
            total_revenue=round(median_revenue, 2),
            net_profit=round(median_revenue - total_spend, 2),
            roi=round((median_revenue - total_spend) / total_spend * 100, 1) if total_spend > 0 else 0,
            new_customers=median_customers,
            mrr_end=round(median_mrr, 2),
            break_even_day=median_be,
            confidence_interval=(round(ci_low, 2), round(ci_high, 2)),
        )

    def run_scenarios(
        self,
        brand: str,
        starting_mrr: float = 0.0,
        period_days: int = 90,
    ) -> dict[str, ForecastResult]:
        """Run conservative, moderate, and aggressive scenarios."""
        scenarios: dict[str, ForecastResult] = {}

        if brand == "cutmv":
            base = FunnelMetrics(brand="cutmv", daily_ad_spend=50, avg_revenue_per_conversion=49)
            conservative = FunnelMetrics(
                brand="cutmv", daily_ad_spend=50,
                impression_to_comment_rate=0.003, dm_to_qualified_rate=0.45,
                qualified_to_action_rate=0.30, signup_to_paid_rate=0.10,
                avg_revenue_per_conversion=29, monthly_churn_rate=0.12,
            )
            aggressive = FunnelMetrics(
                brand="cutmv", daily_ad_spend=150,
                impression_to_comment_rate=0.008, dm_to_qualified_rate=0.70,
                qualified_to_action_rate=0.50, signup_to_paid_rate=0.20,
                avg_revenue_per_conversion=59, monthly_churn_rate=0.06,
            )
        else:
            base = FunnelMetrics(brand="fulldigital", daily_ad_spend=30, avg_deal_value=5000)
            conservative = FunnelMetrics(
                brand="fulldigital", daily_ad_spend=30,
                impression_to_comment_rate=0.003, dm_to_qualified_rate=0.40,
                qualified_to_action_rate=0.25, booked_to_show_rate=0.55,
                show_to_close_rate=0.15, avg_deal_value=3500, monthly_churn_rate=0.10,
            )
            aggressive = FunnelMetrics(
                brand="fulldigital", daily_ad_spend=100,
                impression_to_comment_rate=0.007, dm_to_qualified_rate=0.65,
                qualified_to_action_rate=0.45, booked_to_show_rate=0.75,
                show_to_close_rate=0.30, avg_deal_value=7500, monthly_churn_rate=0.05,
                avg_client_lifetime_months=9,
            )

        scenarios["conservative"] = self.run_forecast(conservative, period_days, starting_mrr, "conservative")
        scenarios["moderate"] = self.run_forecast(base, period_days, starting_mrr, "moderate")
        scenarios["aggressive"] = self.run_forecast(aggressive, period_days, starting_mrr, "aggressive")

        return scenarios
