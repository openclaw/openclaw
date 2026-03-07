"""GrantOps scoring engine — fit score and effort score computation.

Fit score: how well an opportunity matches the business profile (0.0 - 1.0).
Effort score: estimated work to apply (0.0 - 1.0, lower = easier).
Priority: derived from fit + effort.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from packages.grantops.models import PortalType, Priority


@dataclass
class BusinessProfile:
    """Snapshot of the business profile used for scoring.

    Loaded from the vault at scan time so scoring is deterministic.
    """
    industries: list[str]
    org_type: str  # "for_profit", "nonprofit", "hybrid"
    location: str  # state or metro area
    typical_project_min_usd: float
    typical_project_max_usd: float
    team_size: int
    past_funders: list[str]  # funders we've won grants from before


# ── Default profile (override via vault) ──

DEFAULT_PROFILE = BusinessProfile(
    industries=["digital media", "creative services", "music", "technology", "arts"],
    org_type="for_profit",
    location="US",
    typical_project_min_usd=5_000,
    typical_project_max_usd=100_000,
    team_size=5,
    past_funders=[],
)


def compute_fit_score(
    opp: dict[str, Any],
    profile: BusinessProfile | None = None,
) -> float:
    """Compute fit score (0.0 - 1.0) for an opportunity against a business profile.

    Factors:
      - Industry alignment (0.25)
      - Amount range match (0.20)
      - Geographic eligibility (0.15)
      - Organization type match (0.15)
      - Past funder success (0.10)
      - Timeline feasibility (0.15)
    """
    p = profile or DEFAULT_PROFILE
    raw_data = opp.get("raw_data") or opp.get("raw_data_json") or {}
    if isinstance(raw_data, str):
        import json
        try:
            raw_data = json.loads(raw_data)
        except (json.JSONDecodeError, TypeError):
            raw_data = {}

    score = 0.0

    # Industry alignment (0.25)
    opp_text = f"{opp.get('name', '')} {opp.get('funder', '')} {raw_data.get('description', '')}".lower()
    industry_hits = sum(1 for ind in p.industries if ind.lower() in opp_text)
    industry_score = min(industry_hits / max(len(p.industries), 1), 1.0)
    score += 0.25 * industry_score

    # Amount range match (0.20)
    opp_min = opp.get("amount_min_usd") or 0
    opp_max = opp.get("amount_max_usd") or 0
    if opp_max > 0:
        # Check overlap between opp range and our typical project range
        overlap_min = max(opp_min, p.typical_project_min_usd)
        overlap_max = min(opp_max, p.typical_project_max_usd)
        if overlap_max >= overlap_min:
            amount_score = 1.0
        elif opp_max < p.typical_project_min_usd:
            # Grant is smaller than our minimum — partial credit
            amount_score = max(0, opp_max / p.typical_project_min_usd)
        else:
            # Grant is larger than our max — still okay if not too much
            amount_score = max(0, 1.0 - (opp_min - p.typical_project_max_usd) / p.typical_project_max_usd)
        score += 0.20 * min(max(amount_score, 0), 1.0)
    else:
        score += 0.10  # Unknown amount gets half credit

    # Geographic eligibility (0.15)
    geo_req = raw_data.get("geographic_scope", "").lower()
    if not geo_req or "national" in geo_req or p.location.lower() in geo_req:
        score += 0.15
    elif "international" in geo_req:
        score += 0.10

    # Organization type match (0.15)
    eligible_types = raw_data.get("eligible_org_types", [])
    if isinstance(eligible_types, str):
        eligible_types = [eligible_types]
    eligible_lower = [t.lower() for t in eligible_types]
    if not eligible_lower or p.org_type.lower() in eligible_lower or "any" in eligible_lower:
        score += 0.15
    elif "small_business" in eligible_lower and p.team_size <= 50:
        score += 0.10

    # Past funder success (0.10)
    funder = opp.get("funder", "").lower()
    if any(f.lower() == funder for f in p.past_funders):
        score += 0.10

    # Timeline feasibility (0.15)
    deadline = opp.get("deadline")
    if deadline:
        from datetime import UTC, datetime
        try:
            dl = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
            days_until = (dl - datetime.now(tz=UTC)).days
            if days_until >= 30:
                score += 0.15
            elif days_until >= 14:
                score += 0.10
            elif days_until >= 7:
                score += 0.05
            # < 7 days = no timeline credit
        except (ValueError, TypeError):
            score += 0.07  # Unknown deadline gets partial credit
    else:
        score += 0.07

    return round(min(max(score, 0.0), 1.0), 3)


def compute_effort_score(opp: dict[str, Any]) -> float:
    """Estimate effort to apply (0.0 - 1.0, lower = easier).

    Factors:
      - Portal complexity (0.30)
      - Required attachments (0.25)
      - Narrative length (0.20)
      - Budget detail (0.15)
      - References required (0.10)
    """
    raw_data = opp.get("raw_data") or opp.get("raw_data_json") or {}
    if isinstance(raw_data, str):
        import json
        try:
            raw_data = json.loads(raw_data)
        except (json.JSONDecodeError, TypeError):
            raw_data = {}

    score = 0.0

    # Portal complexity (0.30)
    portal = opp.get("portal_type", "guided")
    portal_scores = {
        "submittable": 0.1,   # API-friendly
        "email": 0.2,         # Simple
        "fluxx": 0.5,         # Complex portal
        "guided": 0.6,        # Manual process
        "portal_other": 0.8,  # Unknown complexity
    }
    score += 0.30 * portal_scores.get(portal, 0.6)

    # Required attachments (0.25)
    attachments = raw_data.get("required_attachments", [])
    if isinstance(attachments, list):
        attach_count = len(attachments)
    else:
        attach_count = 2  # Assume moderate if unknown
    score += 0.25 * min(attach_count / 5, 1.0)

    # Narrative length (0.20)
    word_limit = raw_data.get("narrative_word_limit", 0)
    if word_limit > 2000:
        score += 0.20
    elif word_limit > 500:
        score += 0.12
    else:
        score += 0.06  # Short or unspecified

    # Budget detail (0.15)
    budget_type = raw_data.get("budget_detail", "summary")
    if budget_type == "line_item":
        score += 0.15
    elif budget_type == "categories":
        score += 0.10
    else:
        score += 0.05

    # References required (0.10)
    refs = raw_data.get("references_required", 0)
    if isinstance(refs, bool):
        refs = 2 if refs else 0
    score += 0.10 * min(refs / 3, 1.0)

    return round(min(max(score, 0.0), 1.0), 3)


def derive_priority(fit_score: float, effort_score: float) -> Priority:
    """Derive priority from fit and effort scores."""
    if fit_score >= 0.8 and effort_score <= 0.5:
        return Priority.URGENT
    elif fit_score >= 0.7:
        return Priority.HIGH
    elif fit_score >= 0.5:
        return Priority.MEDIUM
    else:
        return Priority.LOW


def score_opportunity(
    opp: dict[str, Any],
    profile: BusinessProfile | None = None,
) -> dict[str, Any]:
    """Score an opportunity and return fit, effort, priority."""
    fit = compute_fit_score(opp, profile)
    effort = compute_effort_score(opp)
    priority = derive_priority(fit, effort)
    return {
        "fit_score": fit,
        "effort_score": effort,
        "priority": priority.value,
    }
