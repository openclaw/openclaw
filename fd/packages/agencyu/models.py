from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class LeadStage(StrEnum):
    NEW = "new"
    QUALIFIED = "qualified"
    BOOKED = "booked"
    NO_SHOW = "no_show"
    CLOSED = "closed"
    NURTURE = "nurture"


class RevenueTier(StrEnum):
    UNDER_5K = "under_5k"
    _5K_15K = "5k_15k"
    _15K_50K = "15k_50k"
    _50K_PLUS = "50k_plus"


class PainPoint(StrEnum):
    ACQUISITION = "acquisition"
    OPERATIONS = "operations"
    TEAM = "team"
    ALL = "all"


class Source(StrEnum):
    META_AD = "meta_ad"
    ORGANIC_REEL = "organic_reel"
    STORY_REPLY = "story_reply"
    CLICK_TO_DM = "click_to_dm"


@dataclass(frozen=True)
class Attribution:
    source: str | None = None
    campaign: str | None = None
    keyword: str | None = None
    utm: dict[str, str] | None = None
    raw: dict[str, Any] | None = None


@dataclass
class LeadUpsert:
    manychat_contact_id: str | None
    ghl_contact_id: str | None
    instagram_handle: str | None
    email: str | None
    phone: str | None

    stage: LeadStage
    revenue_tier: RevenueTier | None
    pain_point: PainPoint | None
    source: Source | None
    campaign: str | None
    engaged_flags: list[str] = field(default_factory=list)
    appointment_ts: str | None = None
    attribution_json: dict[str, Any] = field(default_factory=dict)
