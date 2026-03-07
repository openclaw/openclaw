"""Visual Era Framework™ — canonical spec + content generator schemas.

The 5-stage framework that powers all Full Digital creative output:

Stage 1 — Era Identity Mapping
    Define the visual language for total consistency.

Stage 2 — Asset Multiplication
    One core idea → 50 deliverables across all platforms.

Stage 3 — Performance Creative Loop
    Test what works → scale winners → rotate on fatigue.

Stage 4 — Drop Spike Strategy (14 days)
    Manufacture attention around the release.

Stage 5 — Post-Release Retargeting
    Convert attention into followers, saves, sales, retainer conversion.

Generator schemas produce structured output for:
- Landing pages
- Ad scripts
- VSL scripts
- Email sequences
- Carousel posts
- Case studies
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.visual_era_framework")


# ── Framework stage definitions ──


@dataclass(frozen=True)
class FrameworkStage:
    """A single stage of the Visual Era Framework."""

    stage_number: int
    name: str
    goal: str
    inputs: list[str]
    outputs: list[str]
    deliverable_groups: list[str]


STAGES: list[FrameworkStage] = [
    FrameworkStage(
        stage_number=1,
        name="Era Identity Mapping",
        goal="Define the visual language so everything is consistent.",
        inputs=[
            "artist_name",
            "persona",
            "release_type",
            "genre_substyle",
            "comp_artists",
            "mood_board_links",
            "color_palette_preference",
        ],
        outputs=[
            "era_statement",
            "visual_rules",
            "do_dont_rules",
            "asset_list_per_platform",
        ],
        deliverable_groups=["era_statement", "visual_rules", "brand_guidelines"],
    ),
    FrameworkStage(
        stage_number=2,
        name="Asset Multiplication",
        goal="One core idea becomes 50 deliverables.",
        inputs=["era_identity", "release_type", "platform_list"],
        outputs=[
            "cover_system",
            "motion_system",
            "social_system",
            "dsp_system",
            "ads_system",
        ],
        deliverable_groups=[
            "cover_main_alt_deluxe",
            "animated_cover_visualizer_lyric",
            "posts_stories_teasers",
            "canvas_headers_banners",
            "static_15s_30s_variants",
        ],
    ),
    FrameworkStage(
        stage_number=3,
        name="Performance Creative Loop",
        goal="Test what works → scale winners.",
        inputs=["ad_creatives", "audience_segments", "budget"],
        outputs=[
            "test_matrix",
            "winner_detection",
            "fatigue_rotation",
        ],
        deliverable_groups=[
            "hooks", "captions", "thumbnails",
            "cta_variants", "format_variants",
        ],
    ),
    FrameworkStage(
        stage_number=4,
        name="Drop Spike Strategy",
        goal="Manufacture attention in the first 14 days.",
        inputs=["release_date", "assets", "budget", "audience"],
        outputs=[
            "countdown_kit",
            "release_day_kit",
            "post_release_kit",
            "retargeting_creatives",
        ],
        deliverable_groups=[
            "countdown_assets", "release_day_assets",
            "post_release_assets", "retarget_creatives",
        ],
    ),
    FrameworkStage(
        stage_number=5,
        name="Post-Release Retargeting",
        goal="Convert attention into followers, saves, sales, retainer.",
        inputs=["release_data", "engagement_data", "retarget_audience"],
        outputs=[
            "proof_ads",
            "story_ads",
            "bts_edits",
            "press_kit",
        ],
        deliverable_groups=[
            "proof_ads", "story_ads",
            "behind_the_scenes", "press_kit_assets",
        ],
    ),
]


# ── Era Identity Mapping ──


@dataclass
class EraIdentity:
    """Result of Stage 1: Era Identity Mapping."""

    artist_name: str
    release_type: str  # single | EP | album
    genre_substyle: str
    era_statement: str  # 1 sentence
    visual_rules: list[dict[str, str]]  # 5 rules: typography, color, texture, motif, composition
    do_rules: list[str]  # 10 "do" rules
    dont_rules: list[str]  # 10 "don't" rules
    color_palette: list[str]  # hex codes
    comp_artists: list[str]
    asset_list: dict[str, list[str]]  # platform → list of assets needed

    def to_dict(self) -> dict[str, Any]:
        return {
            "artist_name": self.artist_name,
            "release_type": self.release_type,
            "genre_substyle": self.genre_substyle,
            "era_statement": self.era_statement,
            "visual_rules": self.visual_rules,
            "do_rules": self.do_rules,
            "dont_rules": self.dont_rules,
            "color_palette": self.color_palette,
            "comp_artists": self.comp_artists,
            "asset_list": self.asset_list,
        }


def generate_era_identity(
    artist_name: str,
    release_type: str,
    genre_substyle: str,
    *,
    comp_artists: list[str] | None = None,
    color_palette: list[str] | None = None,
) -> EraIdentity:
    """Generate an Era Identity template for a client.

    Returns a structured template with placeholder rules that the creative
    team fills in. This gives the team a framework, not a final product.
    """
    comps = comp_artists or []
    palette = color_palette or ["#000000", "#FFFFFF"]

    era_statement = (
        f"The {release_type} era for {artist_name} is defined by "
        f"{genre_substyle} energy — commanding, precise, unapologetic."
    )

    visual_rules = [
        {"rule": "typography", "description": "Bold sans-serif, all caps for titles, condensed for body"},
        {"rule": "color", "description": f"Primary: {palette[0] if palette else '#000'}, Accent: {palette[1] if len(palette) > 1 else '#FFF'}"},
        {"rule": "texture", "description": "Grain overlay, matte finish, no glossy effects"},
        {"rule": "motif", "description": "Recurring visual symbol tied to the release concept"},
        {"rule": "composition", "description": "Center-weighted, strong negative space, editorial framing"},
    ]

    do_rules = [
        "Use the defined color palette in every asset",
        "Maintain consistent typography hierarchy",
        "Apply the era motif subtly in all social content",
        "Keep negative space — let the art breathe",
        "Match the energy of the music in every visual",
    ]

    dont_rules = [
        "Don't use colors outside the palette",
        "Don't mix more than 2 typefaces",
        "Don't use stock imagery",
        "Don't deviate from the era statement",
        "Don't publish assets without the visual rules applied",
    ]

    asset_list = {
        "spotify": ["cover_art", "canvas", "header", "about_photo"],
        "apple_music": ["cover_art", "artist_photo", "animated_cover"],
        "instagram": ["posts_x10", "stories_x15", "reels_x5", "highlights_covers"],
        "tiktok": ["profile_photo", "video_templates_x3"],
        "youtube": ["thumbnail_template", "banner", "end_screen"],
        "ads": ["static_x5", "video_15s_x3", "video_30s_x2"],
    }

    return EraIdentity(
        artist_name=artist_name,
        release_type=release_type,
        genre_substyle=genre_substyle,
        era_statement=era_statement,
        visual_rules=visual_rules,
        do_rules=do_rules,
        dont_rules=dont_rules,
        color_palette=palette,
        comp_artists=comps,
        asset_list=asset_list,
    )


# ── Generator Schemas ──


def landing_page_schema(
    brand: str,
    offer_id: str,
    angle_id: str,
) -> dict[str, Any]:
    """Schema for generating a landing page."""
    return {
        "schema_type": "landing_page",
        "brand": brand,
        "offer_id": offer_id,
        "angle_id": angle_id,
        "fields": {
            "headline": {"type": "string", "max_length": 80, "required": True},
            "subheadline": {"type": "string", "max_length": 150, "required": True},
            "bullets": {"type": "list", "max_items": 6, "required": True},
            "proof_blocks": {
                "type": "list",
                "item_schema": {
                    "type": {"enum": ["testimonial", "case_study", "stat", "screenshot"]},
                    "content": {"type": "string"},
                    "source": {"type": "string"},
                },
                "required": True,
            },
            "cta_primary": {"type": "string", "max_length": 40, "required": True},
            "cta_secondary": {"type": "string", "max_length": 40},
            "faq": {
                "type": "list",
                "item_schema": {
                    "question": {"type": "string"},
                    "answer": {"type": "string"},
                },
            },
            "guarantee": {"type": "string"},
            "objections": {"type": "list", "max_items": 5},
            "urgency_element": {"type": "string"},
        },
    }


def ad_script_schema(
    brand: str,
    format_type: str = "ugc",
    length_sec: int = 20,
) -> dict[str, Any]:
    """Schema for generating an ad script."""
    return {
        "schema_type": "ad_script",
        "brand": brand,
        "format": format_type,
        "length_sec": length_sec,
        "fields": {
            "hook": {"type": "string", "max_length": 60, "required": True, "description": "First 3 seconds — stop the scroll"},
            "problem": {"type": "string", "max_length": 120, "required": True, "description": "Agitate the pain"},
            "mechanism": {"type": "string", "max_length": 150, "required": True, "description": "Introduce the solution"},
            "proof": {"type": "string", "max_length": 100, "required": True, "description": "Social proof / result"},
            "cta": {"type": "string", "max_length": 40, "required": True, "description": "Clear next step"},
        },
    }


def vsl_script_schema(
    brand: str,
    length_sec: int = 1200,
) -> dict[str, Any]:
    """Schema for generating a VSL script."""
    return {
        "schema_type": "vsl_script",
        "brand": brand,
        "length_sec": length_sec,
        "sections": [
            {"name": "hook", "duration_sec": 30, "goal": "Stop scroll, create curiosity"},
            {"name": "problem_agitation", "duration_sec": 120, "goal": "Deep pain identification"},
            {"name": "mechanism_reveal", "duration_sec": 180, "goal": "Introduce Visual Era Framework"},
            {"name": "proof_stack", "duration_sec": 180, "goal": "Case studies, results, testimonials"},
            {"name": "offer_reveal", "duration_sec": 120, "goal": "Present the package + pricing"},
            {"name": "objection_handling", "duration_sec": 120, "goal": "Address top 5 objections"},
            {"name": "urgency_close", "duration_sec": 60, "goal": "Scarcity + final CTA"},
            {"name": "recap_cta", "duration_sec": 30, "goal": "Summarize + clear next step"},
        ],
    }


def email_sequence_schema(
    brand: str,
    sequence_type: str = "nurture",
) -> dict[str, Any]:
    """Schema for generating an email sequence."""
    return {
        "schema_type": "email_sequence",
        "brand": brand,
        "sequence_type": sequence_type,
        "fields_per_email": {
            "subject": {"type": "string", "max_length": 60, "required": True},
            "preview_text": {"type": "string", "max_length": 90},
            "body_html": {"type": "string", "required": True},
            "cta_text": {"type": "string", "max_length": 30},
            "cta_url": {"type": "string"},
            "send_delay_hours": {"type": "integer"},
        },
    }


def carousel_schema(
    brand: str,
    slide_count: int = 10,
) -> dict[str, Any]:
    """Schema for generating a carousel post."""
    return {
        "schema_type": "carousel",
        "brand": brand,
        "slide_count": slide_count,
        "fields_per_slide": {
            "headline": {"type": "string", "max_length": 40},
            "body": {"type": "string", "max_length": 120},
            "visual_direction": {"type": "string"},
        },
        "fields": {
            "caption": {"type": "string", "max_length": 2200},
            "hashtags": {"type": "list", "max_items": 30},
            "cta": {"type": "string"},
        },
    }


def case_study_schema(brand: str) -> dict[str, Any]:
    """Schema for generating a case study."""
    return {
        "schema_type": "case_study",
        "brand": brand,
        "fields": {
            "client_name": {"type": "string", "required": True},
            "before_state": {"type": "string", "required": True},
            "after_state": {"type": "string", "required": True},
            "mechanism_used": {"type": "string", "required": True},
            "timeline": {"type": "string"},
            "key_metrics": {
                "type": "list",
                "item_schema": {"metric": "string", "before": "string", "after": "string"},
            },
            "testimonial_quote": {"type": "string"},
            "visuals": {"type": "list", "description": "Before/after screenshots, charts"},
        },
    }


# ── Framework summary ──


def get_framework_summary() -> dict[str, Any]:
    """Return the full Visual Era Framework summary for documentation/display."""
    return {
        "name": "The Visual Era Framework™",
        "stages": [
            {
                "stage": s.stage_number,
                "name": s.name,
                "goal": s.goal,
                "inputs": s.inputs,
                "outputs": s.outputs,
                "deliverable_groups": s.deliverable_groups,
            }
            for s in STAGES
        ],
        "generator_schemas": [
            "landing_page",
            "ad_script",
            "vsl_script",
            "email_sequence",
            "carousel",
            "case_study",
        ],
    }
