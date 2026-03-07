"""Carousel generator — produces structured carousel posts."""
from __future__ import annotations

from typing import Any

from packages.agencyu.marketing.visual_era_framework import carousel_schema


def generate_carousel(
    brand: str,
    content_type: str,
    topic: str,
    *,
    slide_count: int = 10,
    spec: Any = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Generate a carousel post template.

    Returns structured slides with headline + body + visual direction.

    If a ContentSpec is provided, validates brand consistency before generating.
    """
    if spec is not None:
        from packages.agencyu.marketing.content.brand_guard import validate_spec

        validate_spec(spec)
        brand = spec.brand

    schema = carousel_schema(brand, slide_count)

    slides: list[dict[str, str]] = []
    slide_templates = [
        ("Hook slide", "Start with the boldest claim or question"),
        ("Problem", "Show the pain they're experiencing"),
        ("Data point", "Stat or comparison that proves the problem"),
        ("Mechanism intro", "Introduce your approach"),
        ("Step 1", "First step of the process"),
        ("Step 2", "Second step of the process"),
        ("Step 3", "Third step of the process"),
        ("Proof", "Before/after or testimonial"),
        ("Result", "The transformation or outcome"),
        ("CTA", "Clear next step — what to do now"),
    ]

    for i in range(min(slide_count, len(slide_templates))):
        headline, direction = slide_templates[i]
        slides.append({
            "slide_number": str(i + 1),
            "headline": f"{headline}: {topic}" if i == 0 else headline,
            "body": f"[{direction}]",
            "visual_direction": direction,
        })

    result: dict[str, Any] = {
        "schema": schema,
        "brand": brand,
        "content_type": content_type,
        "topic": topic,
        "slides": slides,
        "caption": f"[Write caption about: {topic} — max 2200 chars]",
        "cta": "[Include call to action]",
    }

    if spec is not None:
        from packages.agencyu.marketing.content.front_matter import render_front_matter

        result["front_matter"] = render_front_matter(spec, correlation_id=correlation_id)

    return result
