#!/usr/bin/env python3
"""
Budget Variance Analyzer

Analyzes actual vs budget vs prior year performance with materiality
threshold filtering, favorable/unfavorable classification, and
department/category breakdown.

Usage:
    python budget_variance_analyzer.py budget_data.json
    python budget_variance_analyzer.py budget_data.json --format json
    python budget_variance_analyzer.py budget_data.json --threshold-pct 5 --threshold-amt 25000
"""

import argparse
import json
import sys
from typing import Any, Dict, List, Optional, Tuple


def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Safely divide two numbers, returning default if denominator is zero."""
    if denominator == 0 or denominator is None:
        return default
    return numerator / denominator


class BudgetVarianceAnalyzer:
    """Analyze budget variances with materiality filtering and classification."""

    def __init__(
        self,
        data: Dict[str, Any],
        threshold_pct: float = 10.0,
        threshold_amt: float = 50000.0,
    ) -> None:
        """
        Initialize the analyzer.

        Args:
            data: Budget data with line items
            threshold_pct: Materiality threshold as percentage (default 10%)
            threshold_amt: Materiality threshold as dollar amount (default $50K)
        """
        self.line_items: List[Dict[str, Any]] = data.get("line_items", [])
        self.period: str = data.get("period", "Current Period")
        self.company: str = data.get("company", "Company")
        self.threshold_pct = threshold_pct
        self.threshold_amt = threshold_amt
        self.variances: List[Dict[str, Any]] = []
        self.material_variances: List[Dict[str, Any]] = []
        self.summary: Dict[str, Any] = {}

    def classify_favorability(
        self, line_type: str, variance_amount: float
    ) -> str:
        """
        Classify variance as favorable or unfavorable.

        Revenue: over budget = favorable
        Expense: under budget = favorable
        """
        if line_type.lower() in ("revenue", "income", "sales"):
            return "Favorable" if variance_amount > 0 else "Unfavorable"
        else:
            # For expenses, under budget (negative variance) is favorable
            return "Favorable" if variance_amount < 0 else "Unfavorable"

    def calculate_variances(self) -> List[Dict[str, Any]]:
        """Calculate variances for all line items."""
        self.variances = []

        for item in self.line_items:
            name = item.get("name", "Unknown")
            line_type = item.get("type", "expense")
            department = item.get("department", "General")
            category = item.get("category", "Other")
            actual = item.get("actual", 0)
            budget = item.get("budget", 0)
            prior_year = item.get("prior_year", None)

            # Budget variance
            budget_var_amt = actual - budget
            budget_var_pct = safe_divide(budget_var_amt, budget) * 100

            # Prior year variance (if available)
            py_var_amt = (actual - prior_year) if prior_year is not None else None
            py_var_pct = (
                safe_divide(py_var_amt, prior_year) * 100
                if prior_year is not None
                else None
            )

            favorability = self.classify_favorability(line_type, budget_var_amt)

            is_material = (
                abs(budget_var_pct) >= self.threshold_pct
                or abs(budget_var_amt) >= self.threshold_amt
            )

            variance_record = {
                "name": name,
                "type": line_type,
                "department": department,
                "category": category,
                "actual": actual,
                "budget": budget,
                "prior_year": prior_year,
                "budget_variance_amount": budget_var_amt,
                "budget_variance_pct": round(budget_var_pct, 2),
                "prior_year_variance_amount": py_var_amt,
                "prior_year_variance_pct": (
                    round(py_var_pct, 2) if py_var_pct is not None else None
                ),
                "favorability": favorability,
                "is_material": is_material,
            }

            self.variances.append(variance_record)

        # Filter material variances
        self.material_variances = [v for v in self.variances if v["is_material"]]

        return self.variances

    def department_summary(self) -> Dict[str, Dict[str, Any]]:
        """Summarize variances by department."""
        departments: Dict[str, Dict[str, float]] = {}

        for v in self.variances:
            dept = v["department"]
            if dept not in departments:
                departments[dept] = {
                    "total_actual": 0.0,
                    "total_budget": 0.0,
                    "total_variance": 0.0,
                    "favorable_count": 0,
                    "unfavorable_count": 0,
                    "line_count": 0,
                }

            departments[dept]["total_actual"] += v["actual"]
            departments[dept]["total_budget"] += v["budget"]
            departments[dept]["total_variance"] += v["budget_variance_amount"]
            departments[dept]["line_count"] += 1
            if v["favorability"] == "Favorable":
                departments[dept]["favorable_count"] += 1
            else:
                departments[dept]["unfavorable_count"] += 1

        # Add variance percentage
        for dept_data in departments.values():
            dept_data["variance_pct"] = round(
                safe_divide(
                    dept_data["total_variance"], dept_data["total_budget"]
                )
                * 100,
                2,
            )

        return departments

    def category_summary(self) -> Dict[str, Dict[str, Any]]:
        """Summarize variances by category."""
        categories: Dict[str, Dict[str, float]] = {}

        for v in self.variances:
            cat = v["category"]
            if cat not in categories:
                categories[cat] = {
                    "total_actual": 0.0,
                    "total_budget": 0.0,
                    "total_variance": 0.0,
                    "line_count": 0,
                }

            categories[cat]["total_actual"] += v["actual"]
            categories[cat]["total_budget"] += v["budget"]
            categories[cat]["total_variance"] += v["budget_variance_amount"]
            categories[cat]["line_count"] += 1

        for cat_data in categories.values():
            cat_data["variance_pct"] = round(
                safe_divide(
                    cat_data["total_variance"], cat_data["total_budget"]
                )
                * 100,
                2,
            )

        return categories

    def generate_executive_summary(self) -> Dict[str, Any]:
        """Generate an executive summary of the variance analysis."""
        total_actual = sum(
            v["actual"] for v in self.variances if v["type"].lower() in ("revenue", "income", "sales")
        )
        total_budget = sum(
            v["budget"] for v in self.variances if v["type"].lower() in ("revenue", "income", "sales")
        )
        total_expense_actual = sum(
            v["actual"] for v in self.variances if v["type"].lower() not in ("revenue", "income", "sales")
        )
        total_expense_budget = sum(
            v["budget"] for v in self.variances if v["type"].lower() not in ("revenue", "income", "sales")
        )

        revenue_variance = total_actual - total_budget
        expense_variance = total_expense_actual - total_expense_budget

        favorable_count = sum(
            1 for v in self.variances if v["favorability"] == "Favorable"
        )
        unfavorable_count = sum(
            1 for v in self.variances if v["favorability"] == "Unfavorable"
        )

        self.summary = {
            "period": self.period,
            "company": self.company,
            "total_line_items": len(self.variances),
            "material_variances_count": len(self.material_variances),
            "favorable_count": favorable_count,
            "unfavorable_count": unfavorable_count,
            "revenue": {
                "actual": total_actual,
                "budget": total_budget,
                "variance_amount": revenue_variance,
                "variance_pct": round(
                    safe_divide(revenue_variance, total_budget) * 100, 2
                ),
            },
            "expenses": {
                "actual": total_expense_actual,
                "budget": total_expense_budget,
                "variance_amount": expense_variance,
                "variance_pct": round(
                    safe_divide(expense_variance, total_expense_budget) * 100, 2
                ),
            },
            "net_impact": revenue_variance - expense_variance,
            "materiality_thresholds": {
                "percentage": self.threshold_pct,
                "amount": self.threshold_amt,
            },
        }

        return self.summary

    def run_analysis(self) -> Dict[str, Any]:
        """Run the complete variance analysis."""
        self.calculate_variances()
        dept_summary = self.department_summary()
        cat_summary = self.category_summary()
        exec_summary = self.generate_executive_summary()

        return {
            "executive_summary": exec_summary,
            "all_variances": self.variances,
            "material_variances": self.material_variances,
            "department_summary": dept_summary,
            "category_summary": cat_summary,
        }

    def format_text(self, results: Dict[str, Any]) -> str:
        """Format results as human-readable text."""
        lines: List[str] = []
        lines.append("=" * 70)
        lines.append("BUDGET VARIANCE ANALYSIS")
        lines.append("=" * 70)

        summary = results["executive_summary"]
        lines.append(f"\n  Company: {summary['company']}")
        lines.append(f"  Period:  {summary['period']}")

        def fmt_money(val: float) -> str:
            sign = "+" if val > 0 else ""
            if abs(val) >= 1e6:
                return f"{sign}${val / 1e6:,.2f}M"
            if abs(val) >= 1e3:
                return f"{sign}${val / 1e3:,.1f}K"
            return f"{sign}${val:,.2f}"

        lines.append(f"\n--- EXECUTIVE SUMMARY ---")
        rev = summary["revenue"]
        exp = summary["expenses"]
        lines.append(
            f"  Revenue:  Actual {fmt_money(rev['actual'])} vs "
            f"Budget {fmt_money(rev['budget'])} "
            f"({fmt_money(rev['variance_amount'])}, {rev['variance_pct']:+.1f}%)"
        )
        lines.append(
            f"  Expenses: Actual {fmt_money(exp['actual'])} vs "
            f"Budget {fmt_money(exp['budget'])} "
            f"({fmt_money(exp['variance_amount'])}, {exp['variance_pct']:+.1f}%)"
        )
        lines.append(f"  Net Impact: {fmt_money(summary['net_impact'])}")
        lines.append(
            f"  Total Items: {summary['total_line_items']}  |  "
            f"Material: {summary['material_variances_count']}  |  "
            f"Favorable: {summary['favorable_count']}  |  "
            f"Unfavorable: {summary['unfavorable_count']}"
        )

        # Material variances
        material = results["material_variances"]
        if material:
            lines.append(f"\n--- MATERIAL VARIANCES ---")
            lines.append(
                f"  (Threshold: {self.threshold_pct}% or "
                f"${self.threshold_amt:,.0f})"
            )
            for v in material:
                lines.append(
                    f"\n  {v['name']} ({v['department']})"
                )
                lines.append(
                    f"    Actual: {fmt_money(v['actual'])} | "
                    f"Budget: {fmt_money(v['budget'])}"
                )
                lines.append(
                    f"    Variance: {fmt_money(v['budget_variance_amount'])} "
                    f"({v['budget_variance_pct']:+.1f}%) - {v['favorability']}"
                )

        # Department summary
        dept = results["department_summary"]
        if dept:
            lines.append(f"\n--- DEPARTMENT SUMMARY ---")
            for dept_name, d in dept.items():
                lines.append(
                    f"  {dept_name}: Variance {fmt_money(d['total_variance'])} "
                    f"({d['variance_pct']:+.1f}%) | "
                    f"Fav: {d['favorable_count']} / Unfav: {d['unfavorable_count']}"
                )

        # Category summary
        cat = results["category_summary"]
        if cat:
            lines.append(f"\n--- CATEGORY SUMMARY ---")
            for cat_name, c in cat.items():
                lines.append(
                    f"  {cat_name}: Variance {fmt_money(c['total_variance'])} "
                    f"({c['variance_pct']:+.1f}%)"
                )

        lines.append("\n" + "=" * 70)
        return "\n".join(lines)


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Analyze budget variances with materiality filtering"
    )
    parser.add_argument(
        "input_file",
        help="Path to JSON file with budget data",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)",
    )
    parser.add_argument(
        "--threshold-pct",
        type=float,
        default=10.0,
        help="Materiality threshold percentage (default: 10)",
    )
    parser.add_argument(
        "--threshold-amt",
        type=float,
        default=50000.0,
        help="Materiality threshold dollar amount (default: 50000)",
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

    analyzer = BudgetVarianceAnalyzer(
        data,
        threshold_pct=args.threshold_pct,
        threshold_amt=args.threshold_amt,
    )

    results = analyzer.run_analysis()

    if args.format == "json":
        print(json.dumps(results, indent=2))
    else:
        print(analyzer.format_text(results))


if __name__ == "__main__":
    main()
