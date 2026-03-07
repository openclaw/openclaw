"""Offer Rotation Engine — structured offer × angle × hook × CTA testing.

Loads the offer positioning matrix from config/offers.yaml and provides:
  - load_offer_matrix(): parse YAML into typed offer objects
  - get_active_offers(): offers for a brand/tier
  - generate_test_variants(): all combinations for A/B testing
  - rotate_offer(): pick next untested or best-performing variant
  - score_variant(): score a variant based on attribution data
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path
from typing import Any

import yaml

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.offer_rotation")

_OFFERS_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "offers.yaml"


# ── Data models ──


@dataclass
class Offer:
    """A single offer from the positioning matrix."""

    offer_id: str
    name: str
    brand: str
    tier: str
    core_outcome: str
    icp: str
    mechanism: str
    pain_primary: str
    pain_secondary: str
    price_anchor: dict[str, int | float]
    hooks: list[str]
    angles: list[dict[str, str]]
    ctas: list[str]
    upsells: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TestVariant:
    """A specific offer × angle × hook × CTA combination to test."""

    offer_id: str
    brand: str
    hook: str
    angle_key: str
    angle_text: str
    cta: str
    variant_key: str  # deterministic hash for dedup


@dataclass
class VariantScore:
    """Performance score for a tested variant."""

    variant_key: str
    impressions: int
    clicks: int
    dm_triggers: int
    bookings: int
    conversions: int
    revenue_cents: int
    ctr: float
    conversion_rate: float
    roas: float
    composite_score: float


# ── Matrix loading ──


def load_offer_matrix(path: Path | None = None) -> dict[str, Offer]:
    """Load the offer positioning matrix from YAML.

    Returns:
        Dict of offer_id → Offer.
    """
    p = path or _OFFERS_PATH
    if not p.exists():
        log.warning("offers_yaml_not_found", extra={"path": str(p)})
        return {}

    with open(p) as f:
        raw = yaml.safe_load(f) or {}

    offers: dict[str, Offer] = {}
    for offer_id, data in raw.get("offers", {}).items():
        # Normalize angles: list of dicts with single key
        angles_raw = data.get("angles", [])
        angles: list[dict[str, str]] = []
        for a in angles_raw:
            if isinstance(a, dict):
                angles.append(a)
            elif isinstance(a, str):
                angles.append({"general": a})

        offers[offer_id] = Offer(
            offer_id=offer_id,
            name=data.get("name", offer_id),
            brand=data.get("brand", ""),
            tier=data.get("tier", ""),
            core_outcome=data.get("core_outcome", ""),
            icp=data.get("icp", ""),
            mechanism=data.get("mechanism", ""),
            pain_primary=data.get("pain_primary", ""),
            pain_secondary=data.get("pain_secondary", ""),
            price_anchor=data.get("price_anchor", {}),
            hooks=data.get("hooks", []),
            angles=angles,
            ctas=data.get("ctas", []),
            upsells=data.get("upsells", []),
        )

    return offers


def get_active_offers(
    brand: str | None = None,
    tier: str | None = None,
    path: Path | None = None,
) -> list[Offer]:
    """Get offers filtered by brand and/or tier."""
    matrix = load_offer_matrix(path)
    result = list(matrix.values())

    if brand:
        result = [o for o in result if o.brand == brand]
    if tier:
        result = [o for o in result if o.tier == tier]

    return result


# ── Variant generation ──


def generate_test_variants(
    offer: Offer,
    *,
    max_variants: int = 50,
) -> list[TestVariant]:
    """Generate all offer × angle × hook × CTA combinations.

    Caps at max_variants to prevent combinatorial explosion.
    """
    angle_pairs: list[tuple[str, str]] = []
    for angle_dict in offer.angles:
        for key, text in angle_dict.items():
            angle_pairs.append((key, text))

    if not angle_pairs:
        angle_pairs = [("general", offer.mechanism)]

    combos = list(product(offer.hooks, angle_pairs, offer.ctas))
    if len(combos) > max_variants:
        combos = combos[:max_variants]

    variants: list[TestVariant] = []
    for hook, (angle_key, angle_text), cta in combos:
        # Deterministic key for dedup
        vkey = f"{offer.offer_id}:{angle_key}:{hash(hook + cta) & 0xFFFF:04x}"
        variants.append(TestVariant(
            offer_id=offer.offer_id,
            brand=offer.brand,
            hook=hook,
            angle_key=angle_key,
            angle_text=angle_text,
            cta=cta,
            variant_key=vkey,
        ))

    return variants


# ── Variant scoring ──


def score_variant(
    conn: sqlite3.Connection,
    variant_key: str,
    *,
    window_days: int = 14,
) -> VariantScore | None:
    """Score a variant's performance from attribution data.

    Looks for attribution events tagged with the variant_key
    in payload_json.variant_key or utm_campaign containing the key.
    """
    try:
        row = conn.execute(
            """SELECT
                COUNT(*) AS impressions,
                SUM(CASE WHEN ae.stage IN ('link_click', 'page_view') THEN 1 ELSE 0 END) AS clicks,
                SUM(CASE WHEN ae.touch_type = 'dm_trigger' THEN 1 ELSE 0 END) AS dm_triggers,
                SUM(CASE WHEN ae.stage IN ('call_booked', 'booking_complete') THEN 1 ELSE 0 END) AS bookings,
                SUM(CASE WHEN ae.stage = 'checkout_paid' THEN 1 ELSE 0 END) AS conversions,
                COALESCE(SUM(
                    CASE WHEN ae.stage = 'checkout_paid'
                    THEN json_extract(ae.payload_json, '$.amount_cents') ELSE 0 END
                ), 0) AS revenue_cents
            FROM attribution_events ae
            WHERE (
                json_extract(ae.payload_json, '$.variant_key') = ?
                OR json_extract(ae.payload_json, '$.utm_campaign') LIKE ?
            )
            AND ae.ts >= datetime('now', ?)""",
            (variant_key, f"%{variant_key}%", f"-{window_days} days"),
        ).fetchone()
    except Exception:
        log.debug("score_variant_query_error", exc_info=True)
        return None

    if not row or row["impressions"] == 0:
        return None

    impressions = int(row["impressions"])
    clicks = int(row["clicks"] or 0)
    conversions = int(row["conversions"] or 0)
    revenue = int(row["revenue_cents"] or 0)

    ctr = clicks / max(1, impressions)
    conv_rate = conversions / max(1, clicks)
    roas = revenue / max(1, impressions)  # revenue per impression (cents)

    # Composite: weighted blend
    composite = (ctr * 30) + (conv_rate * 40) + min(30.0, roas / 100)

    return VariantScore(
        variant_key=variant_key,
        impressions=impressions,
        clicks=clicks,
        dm_triggers=int(row["dm_triggers"] or 0),
        bookings=int(row["bookings"] or 0),
        conversions=conversions,
        revenue_cents=revenue,
        ctr=round(ctr, 4),
        conversion_rate=round(conv_rate, 4),
        roas=round(roas, 2),
        composite_score=round(composite, 2),
    )


def rotate_offer(
    conn: sqlite3.Connection,
    brand: str,
    *,
    window_days: int = 14,
) -> dict[str, Any]:
    """Pick the next variant to test or the best-performing one.

    Strategy:
    1. Load all offers for brand
    2. Generate variants for flagship offer
    3. Score tested variants
    4. Return best performer or untested variant

    Returns dict with recommended variant + scoring context.
    """
    offers = get_active_offers(brand=brand)
    if not offers:
        return {"ok": False, "reason": "no_offers_for_brand"}

    # Prioritize flagship tier
    flagship = next((o for o in offers if o.tier == "flagship"), offers[0])
    variants = generate_test_variants(flagship)

    scored: list[VariantScore] = []
    untested: list[TestVariant] = []

    for v in variants:
        s = score_variant(conn, v.variant_key, window_days=window_days)
        if s:
            scored.append(s)
        else:
            untested.append(v)

    if untested:
        # Prefer untested variants
        pick = untested[0]
        return {
            "ok": True,
            "action": "test_new",
            "variant": {
                "variant_key": pick.variant_key,
                "offer_id": pick.offer_id,
                "hook": pick.hook,
                "angle": pick.angle_text,
                "cta": pick.cta,
            },
            "untested_remaining": len(untested),
            "tested_count": len(scored),
        }

    if scored:
        best = max(scored, key=lambda s: s.composite_score)
        return {
            "ok": True,
            "action": "scale_winner",
            "variant_key": best.variant_key,
            "composite_score": best.composite_score,
            "roas": best.roas,
            "conversions": best.conversions,
            "tested_count": len(scored),
        }

    return {"ok": True, "action": "no_data", "variants_available": len(variants)}
