#!/usr/bin/env python3
"""
Forecast Builder

Driver-based revenue forecasting with 13-week rolling cash flow projection,
scenario modeling (base/bull/bear), and trend analysis using simple linear
regression (standard library only).

Usage:
    python forecast_builder.py forecast_data.json
    python forecast_builder.py forecast_data.json --format json
    python forecast_builder.py forecast_data.json --scenarios base,bull,bear
"""

import argparse
import json
import math
import sys
from statistics import mean
from typing import Any, Dict, List, Optional, Tuple


def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Safely divide two numbers, returning default if denominator is zero."""
    if denominator == 0 or denominator is None:
        return default
    return numerator / denominator


def simple_linear_regression(
    x_values: List[float], y_values: List[float]
) -> Tuple[float, float, float]:
    """
    Simple linear regression using standard library.

    Returns (slope, intercept, r_squared).
    """
    n = len(x_values)
    if n < 2 or n != len(y_values):
        return (0.0, 0.0, 0.0)

    x_mean = mean(x_values)
    y_mean = mean(y_values)

    ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(x_values, y_values))
    ss_xx = sum((x - x_mean) ** 2 for x in x_values)
    ss_yy = sum((y - y_mean) ** 2 for y in y_values)

    slope = safe_divide(ss_xy, ss_xx)
    intercept = y_mean - slope * x_mean

    # R-squared
    r_squared = safe_divide(ss_xy ** 2, ss_xx * ss_yy) if ss_yy > 0 else 0.0

    return (slope, intercept, r_squared)


class ForecastBuilder:
    """Driver-based revenue forecasting with scenario modeling."""

    def __init__(self, data: Dict[str, Any]) -> None:
        """Initialize the forecast builder."""
        self.historical: List[Dict[str, Any]] = data.get("historical_periods", [])
        self.drivers: Dict[str, Any] = data.get("drivers", {})
        self.assumptions: Dict[str, Any] = data.get("assumptions", {})
        self.cash_flow_inputs: Dict[str, Any] = data.get("cash_flow_inputs", {})
        self.scenarios_config: Dict[str, Any] = data.get("scenarios", {})
        self.forecast_periods: int = data.get("forecast_periods", 12)

    def analyze_trends(self) -> Dict[str, Any]:
        """Analyze historical trends using linear regression."""
        if not self.historical:
            return {"error": "No historical data available"}

        # Extract revenue series
        revenues = [p.get("revenue", 0) for p in self.historical]
        periods = list(range(1, len(revenues) + 1))

        slope, intercept, r_squared = simple_linear_regression(
            [float(x) for x in periods],
            [float(y) for y in revenues],
        )

        # Calculate growth rates
        growth_rates = []
        for i in range(1, len(revenues)):
            if revenues[i - 1] > 0:
                growth = (revenues[i] - revenues[i - 1]) / revenues[i - 1]
                growth_rates.append(growth)

        avg_growth = mean(growth_rates) if growth_rates else 0.0

        # Seasonality detection (if enough data)
        seasonality_index: List[float] = []
        if len(revenues) >= 4:
            overall_avg = mean(revenues)
            if overall_avg > 0:
                seasonality_index = [r / overall_avg for r in revenues[-4:]]

        return {
            "trend": {
                "slope": round(slope, 2),
                "intercept": round(intercept, 2),
                "r_squared": round(r_squared, 4),
                "direction": "upward" if slope > 0 else "downward" if slope < 0 else "flat",
            },
            "growth_rates": [round(g, 4) for g in growth_rates],
            "average_growth_rate": round(avg_growth, 4),
            "seasonality_index": [round(s, 4) for s in seasonality_index],
            "historical_revenues": revenues,
        }

    def build_driver_based_forecast(
        self, scenario: str = "base"
    ) -> Dict[str, Any]:
        """
        Build a driver-based revenue forecast.

        Drivers may include: units, price, customers, ARPU, conversion rate, etc.
        """
        scenario_adjustments = self.scenarios_config.get(scenario, {})
        growth_adjustment = scenario_adjustments.get("growth_adjustment", 0.0)
        margin_adjustment = scenario_adjustments.get("margin_adjustment", 0.0)

        base_revenue = 0.0
        if self.historical:
            base_revenue = self.historical[-1].get("revenue", 0)

        # Driver-based calculation
        unit_drivers = self.drivers.get("units", {})
        price_drivers = self.drivers.get("pricing", {})
        customer_drivers = self.drivers.get("customers", {})

        base_growth = self.assumptions.get("revenue_growth_rate", 0.05)
        adjusted_growth = base_growth + growth_adjustment

        base_margin = self.assumptions.get("gross_margin", 0.40)
        adjusted_margin = base_margin + margin_adjustment

        cogs_pct = 1.0 - adjusted_margin
        opex_pct = self.assumptions.get("opex_pct_revenue", 0.25)

        forecast_periods: List[Dict[str, Any]] = []
        current_revenue = base_revenue

        # If we have unit and price drivers, use them
        has_unit_drivers = bool(unit_drivers) and bool(price_drivers)

        if has_unit_drivers:
            base_units = unit_drivers.get("base_units", 1000)
            unit_growth = unit_drivers.get("growth_rate", 0.03) + growth_adjustment
            base_price = price_drivers.get("base_price", 100)
            price_growth = price_drivers.get("annual_increase", 0.02)

            current_units = base_units
            current_price = base_price

            for period in range(1, self.forecast_periods + 1):
                current_units = current_units * (1 + unit_growth / 12)
                if period % 12 == 0:
                    current_price = current_price * (1 + price_growth)

                period_revenue = current_units * current_price
                cogs = period_revenue * cogs_pct
                gross_profit = period_revenue - cogs
                opex = period_revenue * opex_pct
                operating_income = gross_profit - opex

                forecast_periods.append({
                    "period": period,
                    "revenue": round(period_revenue, 2),
                    "units": round(current_units, 0),
                    "price": round(current_price, 2),
                    "cogs": round(cogs, 2),
                    "gross_profit": round(gross_profit, 2),
                    "gross_margin": round(adjusted_margin, 4),
                    "opex": round(opex, 2),
                    "operating_income": round(operating_income, 2),
                })
        else:
            # Simple growth-based forecast
            monthly_growth = (1 + adjusted_growth) ** (1 / 12) - 1

            for period in range(1, self.forecast_periods + 1):
                current_revenue = current_revenue * (1 + monthly_growth)
                cogs = current_revenue * cogs_pct
                gross_profit = current_revenue - cogs
                opex = current_revenue * opex_pct
                operating_income = gross_profit - opex

                forecast_periods.append({
                    "period": period,
                    "revenue": round(current_revenue, 2),
                    "cogs": round(cogs, 2),
                    "gross_profit": round(gross_profit, 2),
                    "gross_margin": round(adjusted_margin, 4),
                    "opex": round(opex, 2),
                    "operating_income": round(operating_income, 2),
                })

        total_revenue = sum(p["revenue"] for p in forecast_periods)
        total_operating_income = sum(p["operating_income"] for p in forecast_periods)

        return {
            "scenario": scenario,
            "growth_rate": round(adjusted_growth, 4),
            "gross_margin": round(adjusted_margin, 4),
            "forecast_periods": forecast_periods,
            "total_revenue": round(total_revenue, 2),
            "total_operating_income": round(total_operating_income, 2),
            "average_monthly_revenue": round(
                safe_divide(total_revenue, len(forecast_periods)), 2
            ),
        }

    def build_rolling_cash_flow(self, weeks: int = 13) -> Dict[str, Any]:
        """Build a 13-week rolling cash flow projection."""
        cfi = self.cash_flow_inputs

        opening_balance = cfi.get("opening_cash_balance", 0)
        weekly_revenue = cfi.get("weekly_revenue", 0)
        collection_rate = cfi.get("collection_rate", 0.85)
        collection_lag_weeks = cfi.get("collection_lag_weeks", 2)

        # Weekly expenses
        weekly_payroll = cfi.get("weekly_payroll", 0)
        weekly_rent = cfi.get("weekly_rent", 0)
        weekly_operating = cfi.get("weekly_operating", 0)
        weekly_other = cfi.get("weekly_other", 0)
        total_weekly_expenses = weekly_payroll + weekly_rent + weekly_operating + weekly_other

        # One-time items
        one_time_items: List[Dict[str, Any]] = cfi.get("one_time_items", [])

        weekly_projections: List[Dict[str, Any]] = []
        running_balance = opening_balance

        # Revenue pipeline for lagged collections
        revenue_pipeline: List[float] = [0.0] * collection_lag_weeks

        for week in range(1, weeks + 1):
            # Revenue collections (lagged)
            revenue_pipeline.append(weekly_revenue)
            collections = revenue_pipeline.pop(0) * collection_rate

            # One-time items for this week
            one_time_inflows = 0.0
            one_time_outflows = 0.0
            one_time_labels: List[str] = []
            for item in one_time_items:
                if item.get("week") == week:
                    amount = item.get("amount", 0)
                    if amount > 0:
                        one_time_inflows += amount
                    else:
                        one_time_outflows += abs(amount)
                    one_time_labels.append(item.get("description", ""))

            total_inflows = collections + one_time_inflows
            total_outflows = total_weekly_expenses + one_time_outflows
            net_cash_flow = total_inflows - total_outflows
            running_balance += net_cash_flow

            weekly_projections.append({
                "week": week,
                "collections": round(collections, 2),
                "one_time_inflows": round(one_time_inflows, 2),
                "total_inflows": round(total_inflows, 2),
                "payroll": round(weekly_payroll, 2),
                "rent": round(weekly_rent, 2),
                "operating": round(weekly_operating, 2),
                "other_expenses": round(weekly_other, 2),
                "one_time_outflows": round(one_time_outflows, 2),
                "total_outflows": round(total_outflows, 2),
                "net_cash_flow": round(net_cash_flow, 2),
                "closing_balance": round(running_balance, 2),
                "notes": ", ".join(one_time_labels) if one_time_labels else "",
            })

        # Summary
        total_inflows = sum(w["total_inflows"] for w in weekly_projections)
        total_outflows = sum(w["total_outflows"] for w in weekly_projections)
        min_balance = min(w["closing_balance"] for w in weekly_projections)
        min_balance_week = next(
            w["week"]
            for w in weekly_projections
            if w["closing_balance"] == min_balance
        )

        return {
            "weeks": weeks,
            "opening_balance": opening_balance,
            "closing_balance": round(running_balance, 2),
            "total_inflows": round(total_inflows, 2),
            "total_outflows": round(total_outflows, 2),
            "net_change": round(total_inflows - total_outflows, 2),
            "minimum_balance": round(min_balance, 2),
            "minimum_balance_week": min_balance_week,
            "cash_runway_weeks": (
                round(safe_divide(running_balance, total_weekly_expenses))
                if total_weekly_expenses > 0
                else None
            ),
            "weekly_projections": weekly_projections,
        }

    def build_scenario_comparison(
        self, scenarios: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Build and compare multiple scenarios."""
        if scenarios is None:
            scenarios = ["base", "bull", "bear"]

        scenario_results: Dict[str, Any] = {}

        for scenario in scenarios:
            scenario_results[scenario] = self.build_driver_based_forecast(scenario)

        # Comparison summary
        comparison: List[Dict[str, Any]] = []
        for scenario in scenarios:
            result = scenario_results[scenario]
            comparison.append({
                "scenario": scenario,
                "total_revenue": result["total_revenue"],
                "total_operating_income": result["total_operating_income"],
                "growth_rate": result["growth_rate"],
                "gross_margin": result["gross_margin"],
                "avg_monthly_revenue": result["average_monthly_revenue"],
            })

        return {
            "scenarios": scenario_results,
            "comparison": comparison,
        }

    def run_full_forecast(
        self, scenarios: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Run the complete forecast analysis."""
        trends = self.analyze_trends()
        scenario_comparison = self.build_scenario_comparison(scenarios)
        cash_flow = self.build_rolling_cash_flow()

        return {
            "trend_analysis": trends,
            "scenario_comparison": scenario_comparison,
            "rolling_cash_flow": cash_flow,
        }

    def format_text(self, results: Dict[str, Any]) -> str:
        """Format forecast results as human-readable text."""
        lines: List[str] = []
        lines.append("=" * 70)
        lines.append("FINANCIAL FORECAST REPORT")
        lines.append("=" * 70)

        def fmt_money(val: float) -> str:
            if abs(val) >= 1e9:
                return f"${val / 1e9:,.2f}B"
            if abs(val) >= 1e6:
                return f"${val / 1e6:,.2f}M"
            if abs(val) >= 1e3:
                return f"${val / 1e3:,.1f}K"
            return f"${val:,.2f}"

        # Trend Analysis
        trend = results["trend_analysis"]
        if "error" not in trend:
            lines.append(f"\n--- TREND ANALYSIS ---")
            t = trend["trend"]
            lines.append(f"  Direction: {t['direction']}")
            lines.append(f"  R-squared: {t['r_squared']:.4f}")
            lines.append(
                f"  Average Historical Growth: "
                f"{trend['average_growth_rate'] * 100:.1f}%"
            )
            if trend["seasonality_index"]:
                lines.append(
                    f"  Seasonality Index (last 4): "
                    f"{', '.join(f'{s:.2f}' for s in trend['seasonality_index'])}"
                )

        # Scenario Comparison
        comp = results["scenario_comparison"]["comparison"]
        lines.append(f"\n--- SCENARIO COMPARISON ---")
        lines.append(
            f"  {'Scenario':<10s}  {'Revenue':>14s}  {'Op. Income':>14s}  "
            f"{'Growth':>8s}  {'Margin':>8s}"
        )
        lines.append("  " + "-" * 62)
        for c in comp:
            lines.append(
                f"  {c['scenario']:<10s}  {fmt_money(c['total_revenue']):>14s}  "
                f"{fmt_money(c['total_operating_income']):>14s}  "
                f"{c['growth_rate'] * 100:>7.1f}%  "
                f"{c['gross_margin'] * 100:>7.1f}%"
            )

        # Base scenario detail
        base = results["scenario_comparison"]["scenarios"].get("base", {})
        if base and base.get("forecast_periods"):
            lines.append(f"\n--- BASE CASE MONTHLY FORECAST ---")
            lines.append(
                f"  {'Period':>6s}  {'Revenue':>12s}  {'Gross Profit':>12s}  "
                f"{'Op. Income':>12s}"
            )
            lines.append("  " + "-" * 48)
            for p in base["forecast_periods"]:
                lines.append(
                    f"  {p['period']:>6d}  {fmt_money(p['revenue']):>12s}  "
                    f"{fmt_money(p['gross_profit']):>12s}  "
                    f"{fmt_money(p['operating_income']):>12s}"
                )

        # Cash Flow
        cf = results["rolling_cash_flow"]
        lines.append(f"\n--- 13-WEEK ROLLING CASH FLOW ---")
        lines.append(f"  Opening Balance: {fmt_money(cf['opening_balance'])}")
        lines.append(f"  Closing Balance: {fmt_money(cf['closing_balance'])}")
        lines.append(f"  Net Change:      {fmt_money(cf['net_change'])}")
        lines.append(
            f"  Minimum Balance: {fmt_money(cf['minimum_balance'])} "
            f"(Week {cf['minimum_balance_week']})"
        )
        if cf.get("cash_runway_weeks"):
            lines.append(f"  Cash Runway:     {cf['cash_runway_weeks']:.0f} weeks")

        lines.append(f"\n  Weekly Detail:")
        lines.append(
            f"  {'Wk':>3s}  {'Inflows':>10s}  {'Outflows':>10s}  "
            f"{'Net':>10s}  {'Balance':>12s}"
        )
        lines.append("  " + "-" * 50)
        for w in cf["weekly_projections"]:
            notes = f"  {w['notes']}" if w["notes"] else ""
            lines.append(
                f"  {w['week']:>3d}  {fmt_money(w['total_inflows']):>10s}  "
                f"{fmt_money(w['total_outflows']):>10s}  "
                f"{fmt_money(w['net_cash_flow']):>10s}  "
                f"{fmt_money(w['closing_balance']):>12s}{notes}"
            )

        lines.append("\n" + "=" * 70)
        return "\n".join(lines)


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Driver-based revenue forecasting with scenario modeling"
    )
    parser.add_argument(
        "input_file",
        help="Path to JSON file with forecast data",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)",
    )
    parser.add_argument(
        "--scenarios",
        type=str,
        default="base,bull,bear",
        help="Comma-separated list of scenarios (default: base,bull,bear)",
    )

    args = parser.parse_args()

    try:
        with open(args.input_file, "r") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: File '{args.input_file}' not found.", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in '{args.input_file}': {e}", file=sys.stderr)
        sys.exit(1)

    builder = ForecastBuilder(data)
    scenarios = [s.strip() for s in args.scenarios.split(",")]

    results = builder.run_full_forecast(scenarios)

    if args.format == "json":
        print(json.dumps(results, indent=2))
    else:
        print(builder.format_text(results))


if __name__ == "__main__":
    main()
