"""Funnel Tags — canonical tag taxonomy for Full Digital + CUTMV revenue system.

Extends the existing model enums with brand-aware, cross-system tag constants.
These are the single source of truth for:
- GHL tags
- Notion tags
- Stripe metadata
- QuickBooks memo field
- Trello card metadata
- ManyChat subscriber fields

Tag format: {category}:{value}
"""
from __future__ import annotations

from enum import StrEnum


class Brand(StrEnum):
    """Brand identity for multi-brand funnel routing."""
    CUTMV = "cutmv"
    FULLDIGITAL = "fulldigital"


class Role(StrEnum):
    """Contact role within the music/creative industry."""
    EDITOR = "editor"
    ARTIST = "artist"
    LABEL = "label"
    MANAGER = "manager"
    PRODUCER = "producer"


class Tier(StrEnum):
    """Revenue tier — aligned with RevenueTier in models.py but as tag values."""
    EMERGING = "emerging"         # < $5k/mo
    BUILDING = "building"         # $5k-$15k/mo
    SCALING = "scaling"           # $15k-$50k/mo
    ESTABLISHED = "established"   # $50k+/mo


class FunnelStatus(StrEnum):
    """Funnel stage — superset of LeadStage for cross-system routing."""
    NEW = "new"
    QUALIFIED = "qualified"
    CALENDLY_SENT = "calendly_sent"
    BOOKED = "booked"
    CALLED = "called"
    CLOSED_WON = "closed_won"
    CLOSED_LOST = "closed_lost"
    NURTURE = "nurture"
    NO_SHOW = "no_show"


class FunnelType(StrEnum):
    """Funnel type — which entry path the lead came through."""
    VSL_APPLICATION = "vsl_application"
    CLICK_TO_DM = "click_to_dm"
    ORGANIC_REEL = "organic_reel"
    STORY_REPLY = "story_reply"
    REFERRAL = "referral"
    CROSS_SELL = "cross_sell"


class Pain(StrEnum):
    """Pain point taxonomy — what the lead needs help with."""
    ACQUISITION = "acquisition"    # Getting new clients/fans
    OPERATIONS = "operations"      # Streamlining delivery
    TEAM = "team"                  # Hiring/delegation
    STRATEGY = "strategy"          # Direction/positioning
    BRANDING = "branding"          # Visual identity
    ALL = "all"                    # Everything


# ─────────────────────────────────────────
# Tag builders — create canonical tag strings
# ─────────────────────────────────────────

def tag(category: str, value: str) -> str:
    """Build a canonical tag string."""
    return f"{category}:{value}"


def brand_tag(brand: Brand) -> str:
    return tag("brand", brand.value)


def role_tag(role: Role) -> str:
    return tag("role", role.value)


def tier_tag(tier: Tier) -> str:
    return tag("tier", tier.value)


def status_tag(status: FunnelStatus) -> str:
    return tag("status", status.value)


def funnel_tag(funnel_type: FunnelType) -> str:
    return tag("funnel", funnel_type.value)


def pain_tag(pain: Pain) -> str:
    return tag("pain", pain.value)


# ─────────────────────────────────────────
# Tag sets for cross-system sync validation
# ─────────────────────────────────────────

ALL_BRANDS = {b.value for b in Brand}
ALL_ROLES = {r.value for r in Role}
ALL_TIERS = {t.value for t in Tier}
ALL_STATUSES = {s.value for s in FunnelStatus}
ALL_FUNNEL_TYPES = {f.value for f in FunnelType}
ALL_PAINS = {p.value for p in Pain}

# Tier mapping to revenue range (cents/month)
TIER_REVENUE_RANGES: dict[str, tuple[int, int]] = {
    Tier.EMERGING: (0, 500_000),
    Tier.BUILDING: (500_000, 1_500_000),
    Tier.SCALING: (1_500_000, 5_000_000),
    Tier.ESTABLISHED: (5_000_000, 100_000_000),
}

# High-value tiers for priority routing
HIGH_VALUE_TIERS = {Tier.SCALING, Tier.ESTABLISHED}

# Roles eligible for Full Digital cross-sell
CROSS_SELL_ELIGIBLE_ROLES = {Role.ARTIST, Role.LABEL, Role.MANAGER}
