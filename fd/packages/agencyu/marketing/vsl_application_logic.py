"""VSL Application Logic — AgencyU VSL → Application → Booking qualification stack.

Evaluates application submissions to determine routing:
- book_call: High-quality, meets thresholds
- nurture: Below thresholds, enter nurture sequence
- delay_followup: Qualified but timeline too long
- reject: Hard disqualification (optional)

Prevents low-quality call volume from clogging the sales calendar.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ApplicationVerdict(StrEnum):
    BOOK_CALL = "book_call"
    NURTURE = "nurture"
    DELAY_FOLLOWUP = "delay_followup"
    REJECT = "reject"


@dataclass(frozen=True)
class ApplicationResult:
    """Result of application evaluation."""
    verdict: ApplicationVerdict
    reasons: list[str]
    score: int  # 0-100 quality score
    delay_days: int | None = None


# Default thresholds (overridable per brand/campaign)
DEFAULT_MIN_MONTHLY_REVENUE = 5_000  # $5k/month minimum
DEFAULT_MIN_BUDGET = 3_000  # $3k minimum investment
DEFAULT_MAX_TIMELINE_WEEKS = 12  # 3 months max timeline


def evaluate_application(
    application: dict[str, Any],
    *,
    min_monthly_revenue: int = DEFAULT_MIN_MONTHLY_REVENUE,
    min_budget: int = DEFAULT_MIN_BUDGET,
    max_timeline_weeks: int = DEFAULT_MAX_TIMELINE_WEEKS,
) -> ApplicationResult:
    """Evaluate a VSL application for call booking qualification.

    Args:
        application: Dict with keys like monthly_revenue, monthly_listeners,
                     budget, release_timeline_weeks, role, tier, pain, etc.
        min_monthly_revenue: Revenue floor ($).
        min_budget: Budget floor ($).
        max_timeline_weeks: Max acceptable project timeline.

    Returns:
        ApplicationResult with verdict, reasons, and quality score.
    """
    reasons: list[str] = []
    score = 50  # Start at midpoint

    # Revenue / listener qualification
    revenue = application.get("monthly_revenue") or 0
    listeners = application.get("monthly_listeners") or 0

    if revenue >= min_monthly_revenue or listeners >= 50_000:
        score += 20
    elif revenue > 0 or listeners > 0:
        score += 5
        reasons.append(f"revenue_below_threshold ({revenue})")
    else:
        reasons.append("no_revenue_data")

    # Budget qualification
    budget = application.get("budget") or 0
    if budget >= min_budget:
        score += 15
    elif budget > 0:
        score += 5
        reasons.append(f"budget_below_threshold ({budget})")
    else:
        reasons.append("no_budget_data")

    # Timeline qualification
    timeline_weeks = application.get("release_timeline_weeks") or 0
    if 0 < timeline_weeks <= max_timeline_weeks:
        score += 10
    elif timeline_weeks > max_timeline_weeks:
        reasons.append(f"timeline_too_long ({timeline_weeks}w)")
    # No penalty for missing timeline

    # Role/tier bonuses
    tier = str(application.get("tier") or "").lower()
    if tier in ("scaling", "established", "15k_50k", "50k_plus"):
        score += 10

    role = str(application.get("role") or "").lower()
    if role in ("label", "manager"):
        score += 5

    # Pain urgency bonus
    pain = str(application.get("pain") or application.get("pain_point") or "").lower()
    if pain in ("strategy", "all", "acquisition"):
        score += 5

    score = min(100, max(0, score))

    # Determine verdict
    if score >= 65:
        if timeline_weeks > max_timeline_weeks:
            return ApplicationResult(
                verdict=ApplicationVerdict.DELAY_FOLLOWUP,
                reasons=reasons,
                score=score,
                delay_days=min(30, (timeline_weeks - max_timeline_weeks) * 7),
            )
        return ApplicationResult(
            verdict=ApplicationVerdict.BOOK_CALL,
            reasons=reasons,
            score=score,
        )

    if score >= 35:
        return ApplicationResult(
            verdict=ApplicationVerdict.NURTURE,
            reasons=reasons,
            score=score,
        )

    return ApplicationResult(
        verdict=ApplicationVerdict.REJECT,
        reasons=reasons,
        score=score,
    )
