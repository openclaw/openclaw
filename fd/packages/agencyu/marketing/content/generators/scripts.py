"""Ad script generator — produces structured ad scripts from framework schemas."""
from __future__ import annotations

from typing import Any

from packages.agencyu.marketing.visual_era_framework import ad_script_schema


def generate_ad_script(
    brand: str,
    offer_id: str,
    angle_id: str,
    *,
    format_type: str = "ugc",
    length_sec: int = 20,
    spec: Any = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Generate an ad script template following the Visual Era Framework.

    Returns a structured script with hook -> problem -> mechanism -> proof -> CTA.

    If a ContentSpec is provided, validates brand consistency before generating.
    """
    if spec is not None:
        from packages.agencyu.marketing.content.brand_guard import validate_spec

        validate_spec(spec)
        brand = spec.brand
        offer_id = spec.offer_id
        angle_id = spec.angle_id

    schema = ad_script_schema(brand, format_type, length_sec)

    result: dict[str, Any] = {
        "schema": schema,
        "offer_id": offer_id,
        "angle_id": angle_id,
        "script": {
            "hook": f"[3s — STOP THE SCROLL for {angle_id}]",
            "problem": f"[5s — Agitate the pain: why {angle_id} matters]",
            "mechanism": "[5s — Introduce the Visual Era Framework solution]",
            "proof": "[4s — Show result / testimonial]",
            "cta": "[3s — Clear next step: book / DM / link]",
        },
        "format": format_type,
        "length_sec": length_sec,
        "brand": brand,
    }

    if spec is not None:
        from packages.agencyu.marketing.content.front_matter import render_front_matter

        result["front_matter"] = render_front_matter(spec, correlation_id=correlation_id)

    return result
