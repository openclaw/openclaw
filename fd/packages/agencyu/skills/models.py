"""Skills Scout domain models.

SkillCandidate — a single skill discovered from an external source.
ScoutReport — aggregated advisory report from a scout run.

These are data-only; no business logic here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

TrustTier = Literal["official", "curated", "community", "unknown"]
RecommendedMode = Literal["safe_then_confirm", "confirm_only", "do_not_install"]


@dataclass
class SkillCandidate:
    """A skill discovered from an external source."""

    skill_key: str
    title: str
    description: str
    source_key: str
    source_url: str
    trust_tier: TrustTier

    license: str | None = None
    tags: list[str] = field(default_factory=list)

    # Heuristics (set by ranker)
    fit_score: float = 0.0
    risk_score: float = 0.0
    recommended_mode: RecommendedMode = "confirm_only"

    # Evidence
    signals: dict[str, Any] = field(default_factory=dict)
    raw_snippet: str | None = None


@dataclass
class ScoutReport:
    """Aggregated advisory report from a scout run."""

    generated_at: str
    candidates: list[SkillCandidate]
    top_full_digital: list[str]
    top_cutmv: list[str]
    do_not_install: list[str]
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "generated_at": self.generated_at,
            "candidates": [_candidate_to_dict(c) for c in self.candidates],
            "top_full_digital": self.top_full_digital,
            "top_cutmv": self.top_cutmv,
            "do_not_install": self.do_not_install,
            "notes": self.notes,
        }


def _candidate_to_dict(c: SkillCandidate) -> dict[str, Any]:
    return {
        "skill_key": c.skill_key,
        "title": c.title,
        "description": c.description,
        "source_key": c.source_key,
        "source_url": c.source_url,
        "trust_tier": c.trust_tier,
        "license": c.license,
        "tags": c.tags,
        "fit_score": c.fit_score,
        "risk_score": c.risk_score,
        "recommended_mode": c.recommended_mode,
        "signals": c.signals,
    }
