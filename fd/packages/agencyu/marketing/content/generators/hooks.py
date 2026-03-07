"""Hook variant generator — produces scroll-stopping openers for ads + reels."""
from __future__ import annotations

from typing import Any


def generate_hook_variants(
    offer_id: str,
    angle_id: str,
    *,
    count: int = 5,
    brand: str = "fulldigital",
    spec: Any = None,
    correlation_id: str = "",
) -> list[dict[str, Any]]:
    """Generate hook variant templates for testing.

    Returns structured hook objects ready for ad creative or reel scripts.
    Each hook targets a different psychological trigger.

    If a ContentSpec is provided, validates brand consistency before generating.
    """
    if spec is not None:
        from packages.agencyu.marketing.content.brand_guard import validate_spec

        validate_spec(spec)
        brand = spec.brand
        offer_id = spec.offer_id
        angle_id = spec.angle_id

    triggers = [
        ("curiosity", "What if..."),
        ("pain", "Stop doing X..."),
        ("authority", "We've helped..."),
        ("social_proof", "See how..."),
        ("mechanism", "The system that..."),
    ]

    variants: list[dict[str, Any]] = []
    for i, (trigger_type, prefix) in enumerate(triggers[:count]):
        variant: dict[str, Any] = {
            "variant_id": f"hook_{offer_id}_{angle_id}_{i}",
            "offer_id": offer_id,
            "angle_id": angle_id,
            "brand": brand,
            "trigger_type": trigger_type,
            "prefix": prefix,
            "template": f"[{trigger_type.upper()}] {prefix} [complete based on angle: {angle_id}]",
            "max_length_sec": 3,
            "platform": "instagram_reels",
        }
        if spec is not None:
            from packages.agencyu.marketing.content.front_matter import render_front_matter
            from packages.agencyu.marketing.content.spec import ContentSpec

            variant["front_matter"] = render_front_matter(
                ContentSpec(
                    brand=brand,
                    offer_id=offer_id,
                    angle_id=angle_id,
                    voice_profile_id=spec.voice_profile_id,
                    content_type="vsl_hook",
                    variant_id=variant["variant_id"],
                ),
                correlation_id=correlation_id,
            )
        variants.append(variant)

    return variants
