"""Cross-Sell Engine — CUTMV → Full Digital qualification logic.

Evaluates whether a CUTMV contact is eligible for the Full Digital
strategy funnel based on role, tier, and engagement signals.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.agencyu.marketing.funnel_tags import (
    Brand,
    Tier,
    CROSS_SELL_ELIGIBLE_ROLES,
    HIGH_VALUE_TIERS,
)


@dataclass(frozen=True)
class CrossSellResult:
    """Result of cross-sell evaluation."""
    eligible: bool
    reason: str
    target_brand: str | None = None
    priority: str = "standard"  # standard | high


def evaluate_cross_sell(contact: dict[str, Any]) -> CrossSellResult:
    """Evaluate whether a contact qualifies for CUTMV → Full Digital cross-sell.

    Args:
        contact: Dict with brand, role, tier, status, engagement fields.

    Returns:
        CrossSellResult with eligibility flag and reason.
    """
    brand = str(contact.get("brand") or "").strip().lower()
    role = str(contact.get("role") or "").strip().lower()
    tier = str(contact.get("tier") or contact.get("revenue_tier") or "").strip().lower()
    status = str(contact.get("status") or contact.get("stage") or "").strip().lower()

    # Only CUTMV contacts
    if brand != Brand.CUTMV:
        return CrossSellResult(eligible=False, reason="not_cutmv_brand")

    # Must be in eligible role
    if role not in {r.value for r in CROSS_SELL_ELIGIBLE_ROLES}:
        return CrossSellResult(eligible=False, reason=f"role_{role}_not_eligible")

    # Must be in scaling+ tier
    if tier not in {t.value for t in HIGH_VALUE_TIERS}:
        return CrossSellResult(eligible=False, reason=f"tier_{tier}_below_threshold")

    # Must be active (not lost)
    if status in ("closed_lost", "nurture"):
        return CrossSellResult(eligible=False, reason=f"status_{status}_not_active")

    # High priority if closed_won (upsell) or called (warm)
    priority = "high" if status in ("closed_won", "called", "booked") else "standard"

    return CrossSellResult(
        eligible=True,
        reason="eligible_for_fulldigital_strategy_funnel",
        target_brand=Brand.FULLDIGITAL,
        priority=priority,
    )
