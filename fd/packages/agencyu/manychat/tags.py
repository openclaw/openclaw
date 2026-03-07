from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from packages.agencyu.models import LeadStage, PainPoint, RevenueTier, Source


@dataclass(frozen=True)
class ParsedTags:
    stage: LeadStage | None = None
    revenue_tier: RevenueTier | None = None
    pain_point: PainPoint | None = None
    source: Source | None = None
    campaign: str | None = None
    engaged_flags: list[str] = field(default_factory=list)


def parse_manychat_tags(tags: Iterable[str]) -> ParsedTags:
    """Normalize ManyChat tags into structured fields.

    Tags expected (AgencyU taxonomy):
      - source:meta_ad
      - campaign:jan_blueprint
      - revenue:15k_50k
      - pain:acquisition
      - status:qualified
      - engaged:replied
    """
    stage = None
    revenue = None
    pain = None
    source = None
    campaign = None
    engaged: list[str] = []

    for t in tags:
        t = (t or "").strip().lower()
        if t.startswith("status:"):
            v = t.split(":", 1)[1]
            if v in LeadStage._value2member_map_:
                stage = LeadStage(v)
        elif t.startswith("revenue:"):
            v = t.split(":", 1)[1].replace("-", "_")
            if v in RevenueTier._value2member_map_:
                revenue = RevenueTier(v)
        elif t.startswith("pain:"):
            v = t.split(":", 1)[1]
            if v in PainPoint._value2member_map_:
                pain = PainPoint(v)
        elif t.startswith("source:"):
            v = t.split(":", 1)[1]
            if v in Source._value2member_map_:
                source = Source(v)
        elif t.startswith("campaign:"):
            campaign = t.split(":", 1)[1]
        elif t.startswith("engaged:"):
            engaged.append(t.split(":", 1)[1])

    return ParsedTags(
        stage=stage,
        revenue_tier=revenue,
        pain_point=pain,
        source=source,
        campaign=campaign,
        engaged_flags=sorted(set(engaged)),
    )
