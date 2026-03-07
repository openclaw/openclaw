from __future__ import annotations

from packages.common.logging import get_logger

log = get_logger("manychat.tags")

# Canonical ManyChat tag categories
TAG_CATEGORIES = {
    "campaign": "campaign:",
    "source": "source:",
    "status": "status:",
    "revenue": "revenue:",
}

# Standard status tags
STATUS_TAGS = {
    "new": "status:new",
    "qualified": "status:qualified",
    "booked": "status:booked",
    "no_show": "status:no_show",
    "closed_won": "status:closed_won",
    "closed_lost": "status:closed_lost",
}

# Standard revenue tier tags
REVENUE_TIER_TAGS = {
    "starter": "revenue:starter",
    "growth": "revenue:growth",
    "scale": "revenue:scale",
}


def parse_tags(tags: list[str]) -> dict[str, list[str]]:
    """Parse a list of ManyChat tags into categorized groups.

    Returns dict keyed by category with lists of values.
    """
    result: dict[str, list[str]] = {cat: [] for cat in TAG_CATEGORIES}
    result["other"] = []

    for tag in tags:
        tag = tag.strip().lower()
        matched = False
        for cat, prefix in TAG_CATEGORIES.items():
            if tag.startswith(prefix):
                val = tag[len(prefix):].strip()
                if val:
                    result[cat].append(val)
                matched = True
                break
        if not matched:
            result["other"].append(tag)

    return result


def build_tag(category: str, value: str) -> str:
    """Build a canonical tag string from category and value."""
    prefix = TAG_CATEGORIES.get(category)
    if not prefix:
        return value
    return f"{prefix}{value.strip().lower()}"


def extract_status(tags: list[str]) -> str | None:
    """Extract the status from a list of tags. Returns the last status found."""
    parsed = parse_tags(tags)
    statuses = parsed.get("status", [])
    return statuses[-1] if statuses else None


def extract_campaign(tags: list[str]) -> str | None:
    """Extract the campaign from a list of tags. Returns the first campaign found."""
    parsed = parse_tags(tags)
    campaigns = parsed.get("campaign", [])
    return campaigns[0] if campaigns else None


def extract_revenue_tier(tags: list[str]) -> str | None:
    """Extract the revenue tier from a list of tags."""
    parsed = parse_tags(tags)
    tiers = parsed.get("revenue", [])
    return tiers[-1] if tiers else None
