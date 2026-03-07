"""Daily report builder for the OpenClaw policy engine.

Produces a JSON-friendly report dict that can be dumped to file,
posted to Notion, emailed, or shown in the admin health endpoint.

The report includes:
- Summary counts (total combos, per-brand, planned actions, quality gate blocks)
- Top/bottom ROAS + spend leaderboards
- Full Digital dual-conversion leaderboard (pipeline CPA, revenue CPA, close rate)
- Quality gate block records (combos where scale was blocked due to low close rate)
- Action list
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from packages.agencyu.marketing.metrics_types import ComboMetrics, ComboMetricsFD


def rank_top_bottom(
    metrics: list[ComboMetrics],
    *,
    key: str,
    n: int = 5,
) -> tuple[list[ComboMetrics], list[ComboMetrics]]:
    """Sort metrics by key descending and return (top_n, bottom_n)."""
    items = sorted(metrics, key=lambda x: getattr(x, key, 0.0), reverse=True)
    top = items[:n]
    bottom = list(reversed(items[-n:])) if len(items) >= n else list(reversed(items))
    return top, bottom


def render_daily_report(
    metrics: list[ComboMetrics],
    actions: list[dict[str, Any]],
    *,
    top_n: int = 5,
    gate_blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the daily policy report.

    Does NOT alter policy decisions — purely a reporting layer.

    Args:
        metrics: All ComboMetrics from the aggregation step.
        actions: Policy actions (after quality gate has been applied).
        top_n: How many combos to include in leaderboards.
        gate_blocks: Quality gate block records (combos where scale was blocked).

    Returns:
        JSON-serialisable dict with summary, leaderboards, FD dual-conversion
        analytics, quality gate blocks, and the action list.
    """
    gate_blocks = gate_blocks or []

    cutmv = [m for m in metrics if m.brand == "cutmv"]
    fd = [m for m in metrics if m.brand == "fulldigital"]

    top_roas, bottom_roas = rank_top_bottom(metrics, key="roas", n=top_n)
    top_spend, _ = rank_top_bottom(metrics, key="spend_usd", n=top_n)

    # Full Digital dual-conversion leaderboard
    fd_leaderboard: list[dict[str, Any]] = []
    for m in fd:
        if isinstance(m, ComboMetricsFD):
            fd_leaderboard.append({
                "combo_id": m.combo_id,
                "spend_usd": m.spend_usd,
                "pipeline_conversions": m.pipeline_conversions,
                "revenue_conversions": m.revenue_conversions,
                "pipeline_cpa": m.pipeline_cpa,
                "revenue_cpa": m.revenue_cpa,
                "close_rate": m.close_rate,
                "bookings": m.bookings,
                "application_submits": m.application_submits,
                "attended_calls": m.attended_calls,
                "show_rate": m.show_rate,
                "roas": m.roas,
                "revenue_usd": m.revenue_usd,
                "calls_observed": m.calls_observed,
                "qualified_count": m.qualified_count,
                "qualified_rate": m.qualified_rate,
                "avg_lead_score": m.avg_lead_score,
            })

    fd_leaderboard.sort(key=lambda x: x["close_rate"], reverse=True)

    return {
        "summary": {
            "combos_total": len(metrics),
            "cutmv_combos": len(cutmv),
            "fulldigital_combos": len(fd),
            "actions_planned": len(actions),
            "quality_gate_blocks": len(gate_blocks),
        },
        "top": {
            "roas": [asdict(m) for m in top_roas],
            "spend": [asdict(m) for m in top_spend],
        },
        "bottom": {
            "roas": [asdict(m) for m in bottom_roas],
        },
        "fulldigital_dual_conversion_leaderboard": fd_leaderboard[:top_n],
        "quality_gate_blocks": gate_blocks,
        "actions": actions,
    }
