"""Authority Flywheel Engine — content authority scoring + case study extraction.

Drives the Content → Authority → DM → Appointment → VSL → Close loop.

Provides:
  - extract_case_studies(): mine closed-won clients for case study candidates
  - generate_content_calendar(): weekly content plan from authority signals
  - repurpose_vsl_assets(): break VSL into micro-content pieces
  - authority_score(): composite score from engagement, frequency, DMs, bookings
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.authority_engine")


# ── Data models ──


@dataclass(frozen=True)
class CaseStudy:
    """Extracted case study candidate from a closed-won client."""

    contact_key: str
    brand: str
    client_name: str
    revenue_cents: int
    service_type: str
    outcome_summary: str
    months_active: int
    score: int  # 0-100 case study strength


@dataclass(frozen=True)
class ContentCalendarItem:
    """Single content piece in the weekly calendar."""

    day_of_week: int  # 0=Mon, 6=Sun
    content_type: str  # case_study | hook | mechanism | social_proof | authority_post | cta
    topic: str
    brand: str
    angle: str
    cta: str


@dataclass(frozen=True)
class VSLAsset:
    """Micro-content piece derived from a VSL."""

    asset_type: str  # hook_clip | pain_point | mechanism_explainer | testimonial_snippet | cta_clip
    title: str
    description: str
    source_vsl: str
    timestamp_range: str  # e.g. "0:00-0:30"


@dataclass
class AuthorityScore:
    """Composite authority score for a brand."""

    brand: str
    overall: float  # 0-100
    engagement_score: float
    frequency_score: float
    dm_trigger_score: float
    booking_influence_score: float
    components: dict[str, Any] = field(default_factory=dict)


# ── Weights ──

_WEIGHT_ENGAGEMENT = 0.25
_WEIGHT_FREQUENCY = 0.25
_WEIGHT_DM_TRIGGERS = 0.25
_WEIGHT_BOOKING_INFLUENCE = 0.25


# ── Case Study Extraction ──


def extract_case_studies(
    conn: sqlite3.Connection,
    brand: str,
    *,
    min_revenue_cents: int = 500_000,  # $5k minimum
    min_months: int = 2,
    limit: int = 10,
) -> list[CaseStudy]:
    """Extract case study candidates from closed-won clients.

    Mines the attribution ledger + payment history for clients with
    strong outcomes (revenue, retention, engagement).
    """
    sql = """
    SELECT
        la.contact_key,
        la.brand,
        COALESCE(json_extract(ae.payload_json, '$.name'), la.contact_key) AS client_name,
        COALESCE(ra.total_revenue_cents, 0) AS revenue_cents,
        COALESCE(json_extract(ae.payload_json, '$.service_type'), 'general') AS service_type,
        CAST(
            (julianday('now') - julianday(la.first_touch_ts)) / 30 AS INTEGER
        ) AS months_active
    FROM lead_attribution la
    LEFT JOIN (
        SELECT contact_key, SUM(amount_cents) AS total_revenue_cents
        FROM revenue_attribution
        GROUP BY contact_key
    ) ra ON ra.contact_key = la.contact_key
    LEFT JOIN attribution_events ae ON ae.chain_id = la.chain_id
        AND ae.stage = 'checkout_paid'
    WHERE la.brand = ?
        AND la.primary_stage IN ('closed_won', 'checkout_paid')
        AND COALESCE(ra.total_revenue_cents, 0) >= ?
    GROUP BY la.contact_key
    ORDER BY revenue_cents DESC
    LIMIT ?
    """
    studies: list[CaseStudy] = []
    try:
        rows = conn.execute(sql, (brand, min_revenue_cents, limit)).fetchall()
    except Exception:
        log.warning("extract_case_studies_query_error", exc_info=True)
        return studies

    for r in rows:
        months = max(1, int(r["months_active"] or 1))
        if months < min_months:
            continue

        revenue = int(r["revenue_cents"] or 0)
        # Score: weighted by revenue magnitude + retention length
        score = min(100, int((revenue / 1_000_000) * 40 + months * 10))

        outcome = (
            f"${revenue / 100:,.0f} revenue over {months} months"
            f" in {r['service_type']}"
        )
        studies.append(CaseStudy(
            contact_key=r["contact_key"],
            brand=r["brand"],
            client_name=r["client_name"] or r["contact_key"],
            revenue_cents=revenue,
            service_type=r["service_type"] or "general",
            outcome_summary=outcome,
            months_active=months,
            score=score,
        ))

    return sorted(studies, key=lambda s: s.score, reverse=True)


# ── Content Calendar ──

_CONTENT_TYPES_WEEKLY = [
    (0, "case_study", "Share a client result"),
    (1, "hook", "Pain-first hook post"),
    (2, "mechanism", "Explain your mechanism"),
    (3, "social_proof", "Screenshot / testimonial"),
    (4, "authority_post", "Industry insight or hot take"),
    (5, "cta", "Direct call to action"),
    (6, "hook", "Weekend engagement hook"),
]


def generate_content_calendar(
    conn: sqlite3.Connection,
    brand: str,
    *,
    week_start: str = "",
) -> list[ContentCalendarItem]:
    """Generate a weekly content calendar based on brand authority signals.

    Rotates through content types: case studies, hooks, mechanism posts,
    social proof, authority posts, and CTAs.
    """
    # Fetch top case studies for content ideas
    case_studies = extract_case_studies(conn, brand, limit=3)
    cs_topics = [cs.outcome_summary for cs in case_studies] if case_studies else [
        "Client transformation story",
        "Before/after showcase",
        "ROI breakdown",
    ]

    # Brand-specific angles
    if brand == "fulldigital":
        angles = [
            "Major label visual quality at indie budget",
            "Your rollout deserves a strategy, not just a post",
            "Stop dropping music without a visual era",
        ]
        ctas = [
            "Book your strategy call",
            "DM 'ROLLOUT' for the playbook",
            "Link in bio for the free VSL",
        ]
    else:  # cutmv
        angles = [
            "Every artist needs a visual identity system",
            "Self-serve creative tools built for musicians",
            "Professional visuals without the agency price tag",
        ]
        ctas = [
            "Start your free trial",
            "Try it free — link in bio",
            "DM 'CREATE' to get started",
        ]

    calendar: list[ContentCalendarItem] = []
    for i, (day, content_type, _desc) in enumerate(_CONTENT_TYPES_WEEKLY):
        topic = cs_topics[i % len(cs_topics)] if content_type == "case_study" else _desc
        calendar.append(ContentCalendarItem(
            day_of_week=day,
            content_type=content_type,
            topic=topic,
            brand=brand,
            angle=angles[i % len(angles)],
            cta=ctas[i % len(ctas)],
        ))

    return calendar


# ── VSL Repurposing ──

_VSL_SEGMENTS = [
    ("hook_clip", "Opening hook", "0:00-0:30"),
    ("pain_point", "Pain agitation segment", "0:30-1:30"),
    ("mechanism_explainer", "Mechanism reveal", "1:30-3:00"),
    ("social_proof", "Case study / proof segment", "3:00-5:00"),
    ("testimonial_snippet", "Testimonial highlight", "5:00-6:00"),
    ("mechanism_explainer", "Process walkthrough", "6:00-8:00"),
    ("pain_point", "Objection handling", "8:00-9:30"),
    ("cta_clip", "Offer reveal + CTA", "9:30-10:30"),
    ("hook_clip", "Alternative hook (re-edit)", "0:00-0:15"),
    ("cta_clip", "Urgency close", "10:30-11:00"),
]


def repurpose_vsl_assets(
    vsl_title: str,
    brand: str,
) -> list[VSLAsset]:
    """Break a VSL into 10 micro-content assets.

    Each asset maps to a segment of the VSL that can be extracted
    and repurposed as standalone social content.
    """
    assets: list[VSLAsset] = []
    for asset_type, desc, time_range in _VSL_SEGMENTS:
        assets.append(VSLAsset(
            asset_type=asset_type,
            title=f"{brand.upper()} — {desc}",
            description=f"Extract from '{vsl_title}': {desc}",
            source_vsl=vsl_title,
            timestamp_range=time_range,
        ))
    return assets


# ── Authority Score ──


def authority_score(
    conn: sqlite3.Connection,
    brand: str,
    *,
    window_days: int = 30,
) -> AuthorityScore:
    """Compute composite authority score for a brand.

    Components:
    - Engagement: comment/DM rate on content-attributed chains
    - Frequency: content posts per week (from scheduled_actions)
    - DM triggers: DM-initiated conversations that entered pipeline
    - Booking influence: % of bookings that touched content first

    All scores are 0-100, weighted equally by default.
    """
    now = datetime.now(UTC)
    since = (now - timedelta(days=window_days)).isoformat()
    components: dict[str, Any] = {}

    # 1. Engagement: DM + comment events from attribution
    engagement = 0.0
    try:
        total_touches = conn.execute(
            """SELECT COUNT(*) FROM attribution_events ae
               JOIN attribution_chains c ON c.chain_id = ae.chain_id
               WHERE c.brand = ? AND ae.ts >= ?""",
            (brand, since),
        ).fetchone()[0]

        engagement_touches = conn.execute(
            """SELECT COUNT(*) FROM attribution_events ae
               JOIN attribution_chains c ON c.chain_id = ae.chain_id
               WHERE c.brand = ? AND ae.ts >= ?
               AND ae.touch_type IN ('dm_trigger', 'comment', 'content_view')""",
            (brand, since),
        ).fetchone()[0]

        engagement = min(100.0, (engagement_touches / max(1, total_touches)) * 200)
        components["total_touches"] = total_touches
        components["engagement_touches"] = engagement_touches
    except Exception:
        log.debug("authority_engagement_query_error", exc_info=True)

    # 2. Frequency: content-related scheduled actions
    frequency = 0.0
    try:
        content_actions = conn.execute(
            """SELECT COUNT(*) FROM scheduled_actions
               WHERE brand = ? AND created_at >= ?
               AND action_type IN ('CONTENT_POST', 'AUTHORITY_POST', 'SOCIAL_POST')""",
            (brand, since),
        ).fetchone()[0]

        weeks = max(1, window_days / 7)
        posts_per_week = content_actions / weeks
        # Target: 5 posts/week = 100
        frequency = min(100.0, posts_per_week * 20)
        components["content_actions"] = content_actions
        components["posts_per_week"] = round(posts_per_week, 1)
    except Exception:
        log.debug("authority_frequency_query_error", exc_info=True)

    # 3. DM triggers: chains that started with DM
    dm_score = 0.0
    try:
        dm_chains = conn.execute(
            """SELECT COUNT(*) FROM attribution_chains
               WHERE brand = ? AND created_at >= ?
               AND entry_stage IN ('dm_trigger', 'dm_inbound')""",
            (brand, since),
        ).fetchone()[0]

        total_chains = conn.execute(
            """SELECT COUNT(*) FROM attribution_chains
               WHERE brand = ? AND created_at >= ?""",
            (brand, since),
        ).fetchone()[0]

        dm_score = min(100.0, (dm_chains / max(1, total_chains)) * 200)
        components["dm_chains"] = dm_chains
        components["total_chains"] = total_chains
    except Exception:
        log.debug("authority_dm_query_error", exc_info=True)

    # 4. Booking influence: bookings with content touchpoint before call
    booking_influence = 0.0
    try:
        total_bookings = conn.execute(
            """SELECT COUNT(DISTINCT ae.chain_id) FROM attribution_events ae
               JOIN attribution_chains c ON c.chain_id = ae.chain_id
               WHERE c.brand = ? AND ae.ts >= ?
               AND ae.stage IN ('call_booked', 'booking_complete')""",
            (brand, since),
        ).fetchone()[0]

        content_influenced = conn.execute(
            """SELECT COUNT(DISTINCT ae.chain_id) FROM attribution_events ae
               JOIN attribution_chains c ON c.chain_id = ae.chain_id
               WHERE c.brand = ? AND ae.ts >= ?
               AND ae.stage IN ('call_booked', 'booking_complete')
               AND EXISTS (
                   SELECT 1 FROM attribution_events ae2
                   WHERE ae2.chain_id = ae.chain_id
                   AND ae2.touch_type IN ('content_view', 'dm_trigger', 'comment')
                   AND ae2.ts < ae.ts
               )""",
            (brand, since),
        ).fetchone()[0]

        booking_influence = min(100.0, (content_influenced / max(1, total_bookings)) * 100)
        components["total_bookings"] = total_bookings
        components["content_influenced_bookings"] = content_influenced
    except Exception:
        log.debug("authority_booking_query_error", exc_info=True)

    overall = (
        engagement * _WEIGHT_ENGAGEMENT
        + frequency * _WEIGHT_FREQUENCY
        + dm_score * _WEIGHT_DM_TRIGGERS
        + booking_influence * _WEIGHT_BOOKING_INFLUENCE
    )

    return AuthorityScore(
        brand=brand,
        overall=round(overall, 1),
        engagement_score=round(engagement, 1),
        frequency_score=round(frequency, 1),
        dm_trigger_score=round(dm_score, 1),
        booking_influence_score=round(booking_influence, 1),
        components=components,
    )
