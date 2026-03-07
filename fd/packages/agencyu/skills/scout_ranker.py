"""Skills Scout — fit + risk scoring for discovered candidates.

Scores each SkillCandidate on two axes (0–100):
- fit_score: How relevant is this skill to Full Digital / CUTMV?
- risk_score: How risky is this skill to install?

Derives recommended_mode:
- "safe_then_confirm": official + low risk
- "confirm_only": curated/community + moderate risk
- "do_not_install": high risk (any tier) or community + elevated risk
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.skills.models import SkillCandidate
from packages.common.logging import get_logger

log = get_logger("agencyu.skills.scout_ranker")


class SkillsScoutRanker:
    """Scores skill candidates for fit and risk."""

    def __init__(
        self,
        fit_profile: dict[str, Any],
        risk_rules: dict[str, Any],
    ) -> None:
        self.fit_profile = fit_profile
        self.risk_rules = risk_rules

    def score(self, candidates: list[SkillCandidate]) -> list[SkillCandidate]:
        """Score all candidates in place. Returns the same list."""
        for c in candidates:
            c.fit_score = self._fit_score(c)
            c.risk_score = self._risk_score(c)
            c.recommended_mode = self._recommend_mode(c)
        return candidates

    def _fit_score(self, c: SkillCandidate) -> float:
        """Compute fit score (0–100) based on keyword matches + trust boost."""
        text = f"{c.title}\n{c.description}\n{c.raw_snippet or ''}".lower()

        score = 0.0
        for brand_key, profile in self.fit_profile.items():
            keywords = profile.get("keywords", [])
            weight = float(profile.get("weight", 1.0))
            for kw in keywords:
                if kw.lower() in text:
                    score += 1.2 * weight

        # Trust tier boost
        if c.trust_tier == "official":
            score *= 1.25
        elif c.trust_tier == "curated":
            score *= 1.10

        return float(min(100.0, score * 4.0))

    def _risk_score(self, c: SkillCandidate) -> float:
        """Compute risk score (0–100) based on high-risk markers."""
        text = f"{c.raw_snippet or ''}\n{c.description}".lower()
        markers = self.risk_rules.get("high_risk_markers", [])
        hits = sum(1 for m in markers if m.lower() in text)

        base = hits * 12.0

        # Trust tier reduces risk slightly (still not "safe")
        if c.trust_tier == "official":
            base *= 0.6
        elif c.trust_tier == "curated":
            base *= 0.8

        return float(min(100.0, base))

    def _recommend_mode(self, c: SkillCandidate) -> str:
        """Determine recommended mode from scores + trust tier.

        Guardrails:
        - High risk (>=70) => do_not_install unless official and below threshold
        - official => safe_then_confirm
        - curated => confirm_only
        - community => confirm_only or do_not_install based on risk
        """
        if c.risk_score >= 70.0:
            return "do_not_install"

        if c.trust_tier == "official":
            return "safe_then_confirm"

        if c.trust_tier == "curated":
            return "confirm_only"

        # community / unknown
        if c.risk_score >= 40.0:
            return "do_not_install"

        return "confirm_only"
