"""Lead Scoring — qualification engine for AgencyU funnel mechanics.

Computes a 0-100 score based on tier, role, status, engagement, and pain.
Thresholds:
- 70+ → Priority Close
- 40-69 → Standard Follow-Up
- <40 → Nurture Sequence
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ScoreBucket(StrEnum):
    PRIORITY_CLOSE = "priority_close"
    STANDARD_FOLLOWUP = "standard_followup"
    NURTURE = "nurture"


@dataclass(frozen=True)
class LeadScore:
    """Result of lead scoring computation."""
    score: int
    bucket: ScoreBucket
    breakdown: dict[str, int]


# Scoring weights
TIER_SCORES: dict[str, int] = {
    "scaling": 40,
    "established": 40,
    "building": 20,
    "emerging": 5,
    # RevenueTier compat
    "15k_50k": 40,
    "50k_plus": 40,
    "5k_15k": 20,
    "under_5k": 5,
}

ROLE_SCORES: dict[str, int] = {
    "label": 30,
    "manager": 30,
    "artist": 20,
    "producer": 15,
    "editor": 10,
}

STATUS_SCORES: dict[str, int] = {
    "booked": 20,
    "called": 15,
    "qualified": 10,
    "calendly_sent": 8,
    "new": 0,
    "nurture": 0,
}

PAIN_SCORES: dict[str, int] = {
    "strategy": 10,
    "all": 10,
    "acquisition": 8,
    "branding": 6,
    "operations": 5,
    "team": 5,
}

# Engagement flag bonuses
ENGAGEMENT_BONUSES: dict[str, int] = {
    "video_watched": 10,
    "replied": 8,
    "link_clicked": 5,
    "email_opened": 3,
    "form_submitted": 10,
    "application_submitted": 15,
}


def compute_lead_score(contact: dict[str, Any]) -> LeadScore:
    """Compute a lead score from contact data.

    Accepts a dict with keys: tier, role, status, pain, engaged_flags (list),
    engagement_flags (dict of booleans), revenue_tier, pain_point.
    Flexible — works with both raw tag values and model enum values.
    """
    breakdown: dict[str, int] = {}

    # Tier score
    tier = str(contact.get("tier") or contact.get("revenue_tier") or "").strip().lower()
    tier_pts = TIER_SCORES.get(tier, 0)
    breakdown["tier"] = tier_pts

    # Role score
    role = str(contact.get("role") or "").strip().lower()
    role_pts = ROLE_SCORES.get(role, 0)
    breakdown["role"] = role_pts

    # Status score
    status = str(contact.get("status") or contact.get("stage") or "").strip().lower()
    status_pts = STATUS_SCORES.get(status, 0)
    breakdown["status"] = status_pts

    # Pain score
    pain = str(contact.get("pain") or contact.get("pain_point") or "").strip().lower()
    pain_pts = PAIN_SCORES.get(pain, 0)
    breakdown["pain"] = pain_pts

    # Engagement score
    engagement_pts = 0
    # Support dict of booleans
    eng_flags = contact.get("engagement_flags") or {}
    if isinstance(eng_flags, dict):
        for flag, bonus in ENGAGEMENT_BONUSES.items():
            if eng_flags.get(flag):
                engagement_pts += bonus
    # Support list of flag strings
    engaged_list = contact.get("engaged_flags") or []
    if isinstance(engaged_list, list):
        for flag in engaged_list:
            engagement_pts += ENGAGEMENT_BONUSES.get(str(flag).lower(), 0)
    breakdown["engagement"] = engagement_pts

    total = min(100, tier_pts + role_pts + status_pts + pain_pts + engagement_pts)

    if total >= 70:
        bucket = ScoreBucket.PRIORITY_CLOSE
    elif total >= 40:
        bucket = ScoreBucket.STANDARD_FOLLOWUP
    else:
        bucket = ScoreBucket.NURTURE

    return LeadScore(score=total, bucket=bucket, breakdown=breakdown)
