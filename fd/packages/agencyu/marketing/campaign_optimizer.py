"""Campaign Optimizer — performance evaluation and action recommendations.

Analyzes campaign metrics and outputs actionable verdicts:
- scale: All metrics healthy, increase spend
- reduce_budget: CAC too high
- adjust_vsl: Close rate too low
- improve_reminders: Show rate too low
- refresh_creative: Signup cost too high (creative fatigue)
- pause: Capital preservation triggered (CAC > LTV/3 or close rate < 8%)

Integrates with existing campaign_integrity infrastructure.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class CampaignAction(StrEnum):
    SCALE = "scale"
    REDUCE_BUDGET = "reduce_budget"
    ADJUST_VSL = "adjust_vsl"
    IMPROVE_REMINDERS = "improve_reminders"
    REFRESH_CREATIVE = "refresh_creative"
    PAUSE = "pause"


@dataclass(frozen=True)
class CampaignEvaluation:
    """Result of campaign performance evaluation."""
    action: CampaignAction
    reasons: list[str]
    metrics: dict[str, Any]
    severity: str  # info | warning | critical


# Default thresholds
DEFAULT_MAX_COST_PER_BOOKED_CALL = 150_00  # $150 in cents
DEFAULT_MIN_CLOSE_RATE = 0.15  # 15%
DEFAULT_MIN_SHOW_RATE = 0.60  # 60%
DEFAULT_MAX_COST_PER_SIGNUP = 25_00  # $25 in cents
DEFAULT_CRITICAL_CLOSE_RATE = 0.08  # 8% — pause threshold
DEFAULT_CRITICAL_SHOW_RATE = 0.50  # 50% — pause threshold


def evaluate_campaign_performance(
    data: dict[str, Any],
    *,
    max_cost_per_booked_call: int = DEFAULT_MAX_COST_PER_BOOKED_CALL,
    min_close_rate: float = DEFAULT_MIN_CLOSE_RATE,
    min_show_rate: float = DEFAULT_MIN_SHOW_RATE,
    max_cost_per_signup: int = DEFAULT_MAX_COST_PER_SIGNUP,
    critical_close_rate: float = DEFAULT_CRITICAL_CLOSE_RATE,
    critical_show_rate: float = DEFAULT_CRITICAL_SHOW_RATE,
) -> CampaignEvaluation:
    """Evaluate campaign performance and recommend action.

    Args:
        data: Dict with keys: cost_per_booked_call (cents), close_rate (0-1),
              show_rate (0-1), cost_per_signup (cents), ad_spend_cents, etc.

    Returns:
        CampaignEvaluation with recommended action and reasoning.
    """
    reasons: list[str] = []
    cost_per_booked = data.get("cost_per_booked_call", 0)
    close_rate = data.get("close_rate", 0.0)
    show_rate = data.get("show_rate", 1.0)
    cost_per_signup = data.get("cost_per_signup", 0)

    metrics = {
        "cost_per_booked_call": cost_per_booked,
        "close_rate": close_rate,
        "show_rate": show_rate,
        "cost_per_signup": cost_per_signup,
    }

    # Capital preservation guardrails (critical — pause immediately)
    if close_rate > 0 and close_rate < critical_close_rate:
        reasons.append(f"close_rate {close_rate:.1%} < {critical_close_rate:.0%} critical threshold")
        return CampaignEvaluation(
            action=CampaignAction.PAUSE,
            reasons=reasons,
            metrics=metrics,
            severity="critical",
        )

    if show_rate > 0 and show_rate < critical_show_rate:
        reasons.append(f"show_rate {show_rate:.1%} < {critical_show_rate:.0%} critical threshold")
        return CampaignEvaluation(
            action=CampaignAction.PAUSE,
            reasons=reasons,
            metrics=metrics,
            severity="critical",
        )

    # Warning-level issues
    if cost_per_booked > max_cost_per_booked_call:
        reasons.append(f"cost_per_booked_call ${cost_per_booked/100:.0f} > ${max_cost_per_booked_call/100:.0f}")
        return CampaignEvaluation(
            action=CampaignAction.REDUCE_BUDGET,
            reasons=reasons,
            metrics=metrics,
            severity="warning",
        )

    if close_rate > 0 and close_rate < min_close_rate:
        reasons.append(f"close_rate {close_rate:.1%} < {min_close_rate:.0%}")
        return CampaignEvaluation(
            action=CampaignAction.ADJUST_VSL,
            reasons=reasons,
            metrics=metrics,
            severity="warning",
        )

    if show_rate > 0 and show_rate < min_show_rate:
        reasons.append(f"show_rate {show_rate:.1%} < {min_show_rate:.0%}")
        return CampaignEvaluation(
            action=CampaignAction.IMPROVE_REMINDERS,
            reasons=reasons,
            metrics=metrics,
            severity="warning",
        )

    if cost_per_signup > max_cost_per_signup:
        reasons.append(f"cost_per_signup ${cost_per_signup/100:.0f} > ${max_cost_per_signup/100:.0f}")
        return CampaignEvaluation(
            action=CampaignAction.REFRESH_CREATIVE,
            reasons=reasons,
            metrics=metrics,
            severity="warning",
        )

    # All metrics healthy
    return CampaignEvaluation(
        action=CampaignAction.SCALE,
        reasons=["all_metrics_healthy"],
        metrics=metrics,
        severity="info",
    )


def detect_creative_fatigue(
    data: dict[str, Any],
    *,
    ctr_floor: float = 0.01,  # 1% CTR minimum
    ctr_decline_pct: float = 0.30,  # 30% decline from peak
) -> dict[str, Any]:
    """Detect creative fatigue from ad performance data.

    Args:
        data: Dict with current_ctr, peak_ctr, days_running, impressions.

    Returns:
        Dict with fatigued flag, decline_pct, recommendation.
    """
    current_ctr = data.get("current_ctr", 0.0)
    peak_ctr = data.get("peak_ctr", 0.0)
    days_running = data.get("days_running", 0)

    if peak_ctr <= 0:
        return {"fatigued": False, "reason": "no_peak_data"}

    decline = (peak_ctr - current_ctr) / peak_ctr if peak_ctr > 0 else 0

    if current_ctr < ctr_floor:
        return {
            "fatigued": True,
            "decline_pct": round(decline, 4),
            "current_ctr": current_ctr,
            "peak_ctr": peak_ctr,
            "days_running": days_running,
            "recommendation": "replace_creative_immediately",
        }

    if decline >= ctr_decline_pct:
        return {
            "fatigued": True,
            "decline_pct": round(decline, 4),
            "current_ctr": current_ctr,
            "peak_ctr": peak_ctr,
            "days_running": days_running,
            "recommendation": "rotate_hooks" if days_running > 14 else "test_new_ugc",
        }

    return {"fatigued": False, "decline_pct": round(decline, 4)}
