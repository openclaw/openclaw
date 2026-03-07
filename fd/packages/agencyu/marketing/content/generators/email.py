"""Email sequence generator — produces structured email sequences."""
from __future__ import annotations

from typing import Any

from packages.agencyu.marketing.visual_era_framework import email_sequence_schema


def generate_email_sequence(
    brand: str,
    sequence_type: str,
    *,
    steps: int = 4,
    spec: Any = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Generate an email sequence template.

    Returns structured emails with subject, body template, and timing.

    If a ContentSpec is provided, validates brand consistency before generating.
    """
    if spec is not None:
        from packages.agencyu.marketing.content.brand_guard import validate_spec

        validate_spec(spec)
        brand = spec.brand

    schema = email_sequence_schema(brand, sequence_type)

    templates: list[dict[str, Any]] = [
        {
            "step": 1,
            "subject": "[Pain-first subject line]",
            "preview_text": "[Preview text that creates curiosity]",
            "body_template": "Hook → Problem → Mechanism tease → CTA",
            "cta_text": "Book your call",
            "send_delay_hours": 0,
        },
        {
            "step": 2,
            "subject": "[Case study subject line]",
            "preview_text": "[Preview with specific result]",
            "body_template": "Story → Problem they had → What we did → Result → CTA",
            "cta_text": "See the full case study",
            "send_delay_hours": 48,
        },
        {
            "step": 3,
            "subject": "[Mechanism subject line]",
            "preview_text": "[Preview explaining the framework]",
            "body_template": "Mechanism deep dive → 5 steps → Why it works → CTA",
            "cta_text": "Watch the free VSL",
            "send_delay_hours": 96,
        },
        {
            "step": 4,
            "subject": "[Urgency subject line]",
            "preview_text": "[Preview with scarcity element]",
            "body_template": "Recap → Urgency → Final CTA → PS line",
            "cta_text": "Book now — limited spots",
            "send_delay_hours": 168,
        },
    ]

    result: dict[str, Any] = {
        "schema": schema,
        "brand": brand,
        "sequence_type": sequence_type,
        "emails": templates[:steps],
    }

    if spec is not None:
        from packages.agencyu.marketing.content.front_matter import render_front_matter

        result["front_matter"] = render_front_matter(spec, correlation_id=correlation_id)

    return result
