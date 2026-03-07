"""Authority Content Auto-Scheduler — weekly content planning + Notion queue seeding.

Turns case studies, wins, and funnel learnings into:
- Weekly content plans based on authority score + KPI gaps
- Notion Content Queue items (for approval)
- Notion Content Calendar entries

Never auto-publishes. Generates drafts + queues for human approval.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.marketing.authority_engine import (
    authority_score,
    extract_case_studies,
    repurpose_vsl_assets,
)
from packages.common.idempotency import seen_or_mark
from packages.common.ids import make_id
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.authority_scheduler")

_SCHEDULE_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "authority_schedule.yaml"


# ── Data models ──


@dataclass(frozen=True)
class ContentItem:
    """A single content piece for the queue."""

    content_type: str
    format: str
    topic: str
    brand: str
    angle: str
    cta: str
    day_of_week: int
    priority: str = "medium"
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "content_type": self.content_type,
            "format": self.format,
            "topic": self.topic,
            "brand": self.brand,
            "angle": self.angle,
            "cta": self.cta,
            "day_of_week": self.day_of_week,
            "priority": self.priority,
            "source": self.source,
        }


@dataclass
class WeekPlan:
    """Weekly content plan."""

    brand: str
    week_start: str
    authority_score_val: float
    kpi_gap: float
    cadence: dict[str, int]
    items: list[ContentItem] = field(default_factory=list)
    urgency: str = "normal"  # normal | high

    def to_dict(self) -> dict[str, Any]:
        return {
            "brand": self.brand,
            "week_start": self.week_start,
            "authority_score": self.authority_score_val,
            "kpi_gap": self.kpi_gap,
            "urgency": self.urgency,
            "cadence": self.cadence,
            "item_count": len(self.items),
            "items": [i.to_dict() for i in self.items],
        }


# ── Config loading ──


def load_schedule_config(path: Path | None = None) -> dict[str, Any]:
    """Load authority_schedule.yaml config."""
    p = path or _SCHEDULE_PATH
    if not p.exists():
        return {}
    with open(p) as f:
        return yaml.safe_load(f) or {}


# ── Schedule building ──


def build_week_plan(
    conn: sqlite3.Connection,
    brand: str,
    *,
    week_start: str = "",
    config: dict[str, Any] | None = None,
) -> WeekPlan:
    """Build a weekly content plan based on authority score and KPI gap.

    Higher urgency (KPI gap > threshold) → increased cadence.
    """
    cfg = config or load_schedule_config()
    schedule_cfg = cfg.get("schedule", {})

    # Authority score
    auth = authority_score(conn, brand)
    score_val = auth.overall

    # KPI gap: estimate from recent booking rate vs target
    kpi_gap = _estimate_kpi_gap(conn, brand)

    urgency_threshold = float(schedule_cfg.get("urgency_threshold_kpi_gap", 2))
    is_urgent = kpi_gap > urgency_threshold

    if is_urgent:
        cadence = dict(schedule_cfg.get("high_urgency_cadence", {"reels": 5, "carousels": 3, "stories": 3, "emails": 2}))
        urgency = "high"
    else:
        cadence = dict(schedule_cfg.get("default_cadence", {"reels": 3, "carousels": 2, "stories": 2, "emails": 1}))
        urgency = "normal"

    if not week_start:
        today = datetime.now(UTC).date()
        # Monday of current week
        monday = today - timedelta(days=today.weekday())
        week_start = monday.isoformat()

    plan = WeekPlan(
        brand=brand,
        week_start=week_start,
        authority_score_val=score_val,
        kpi_gap=kpi_gap,
        cadence=cadence,
        urgency=urgency,
    )

    # Generate content items from weekly template
    items = _generate_content_items(conn, brand, plan, cfg)
    plan.items = items

    return plan


def _estimate_kpi_gap(conn: sqlite3.Connection, brand: str) -> float:
    """Estimate daily KPI gap (bookings needed - bookings getting)."""
    try:
        row = conn.execute(
            """SELECT COUNT(*) AS cnt
               FROM attribution_events ae
               JOIN attribution_chains c ON c.chain_id = ae.chain_id
               WHERE c.brand = ? AND ae.stage IN ('call_booked', 'booking_complete')
                 AND ae.ts >= datetime('now', '-7 days')""",
            (brand,),
        ).fetchone()
        weekly_bookings = int(row[0]) if row else 0
        daily_bookings = weekly_bookings / 7

        # Target: 3 bookings/day for FD, 5 for CUTMV
        target = 3.0 if brand == "fulldigital" else 5.0
        return max(0, target - daily_bookings)
    except Exception:
        return 0.0


def _generate_content_items(
    conn: sqlite3.Connection,
    brand: str,
    plan: WeekPlan,
    cfg: dict[str, Any],
) -> list[ContentItem]:
    """Generate content items based on weekly template + source signals."""
    template = cfg.get("weekly_template", [])
    items: list[ContentItem] = []

    # Get case studies for content ideas
    case_studies = extract_case_studies(conn, brand, limit=3)
    cs_topics = [cs.outcome_summary for cs in case_studies] if case_studies else [
        "Client transformation story",
        "Before/after showcase",
        "ROI breakdown",
    ]

    # Brand-specific angles + CTAs
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
    else:
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

    for i, entry in enumerate(template):
        day = entry.get("day", i)
        content_type = entry.get("content_type", "hook")
        fmt = entry.get("format", "reel")
        priority = entry.get("priority", "medium")
        desc = entry.get("description", "")

        topic = cs_topics[i % len(cs_topics)] if content_type == "case_study" else desc
        items.append(ContentItem(
            content_type=content_type,
            format=fmt,
            topic=topic,
            brand=brand,
            angle=angles[i % len(angles)],
            cta=ctas[i % len(ctas)],
            day_of_week=day,
            priority=priority,
            source="weekly_template",
        ))

    return items


# ── Queue seeding ──


def seed_content_queue(
    conn: sqlite3.Connection,
    brand: str,
    *,
    safe_mode: bool = True,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create content queue items from the weekly plan.

    In safe_mode, returns planned items without writing to DB.
    """
    cfg = config or load_schedule_config()
    safety = cfg.get("safety", {})
    max_items = int(safety.get("max_items_per_seed", 15))

    plan = build_week_plan(conn, brand, config=cfg)

    if safe_mode:
        return {
            "ok": True,
            "safe_mode": True,
            "brand": brand,
            "plan": plan.to_dict(),
            "planned_items": len(plan.items),
            "applied": 0,
        }

    applied = 0
    now = datetime.now(UTC).isoformat()

    for item in plan.items[:max_items]:
        idem_key = f"content:{brand}:{plan.week_start}:{item.content_type}:{item.day_of_week}"
        if seen_or_mark(conn, idem_key):
            continue

        try:
            conn.execute(
                """INSERT INTO content_queue
                   (id, brand, content_type, format, angle_id, topic, status, priority,
                    week_start, day_of_week, idempotency_key, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)""",
                (
                    make_id("cq"),
                    brand,
                    item.content_type,
                    item.format,
                    item.angle,
                    item.topic,
                    item.priority,
                    plan.week_start,
                    item.day_of_week,
                    idem_key,
                    now,
                    now,
                ),
            )
            applied += 1
        except Exception:
            log.debug("seed_content_queue_error", exc_info=True)

    try:
        conn.commit()
    except Exception:
        pass

    return {
        "ok": True,
        "safe_mode": False,
        "brand": brand,
        "plan": plan.to_dict(),
        "planned_items": len(plan.items),
        "applied": applied,
    }


def get_weekly_authority_report(
    conn: sqlite3.Connection,
    brand: str,
) -> dict[str, Any]:
    """Generate the weekly authority report for brain.py."""
    auth = authority_score(conn, brand)
    case_studies = extract_case_studies(conn, brand, limit=5)

    # Count content queue items this week
    today = datetime.now(UTC).date()
    monday = today - timedelta(days=today.weekday())
    week_start = monday.isoformat()

    content_count = 0
    try:
        row = conn.execute(
            """SELECT COUNT(*) AS cnt FROM content_queue
               WHERE brand = ? AND week_start = ?""",
            (brand, week_start),
        ).fetchone()
        content_count = int(row[0]) if row else 0
    except Exception:
        pass

    # Bookings influenced by authority content
    bookings_influenced = 0
    try:
        row = conn.execute(
            """SELECT COUNT(DISTINCT ae.chain_id)
               FROM attribution_events ae
               JOIN attribution_chains c ON c.chain_id = ae.chain_id
               WHERE c.brand = ?
                 AND ae.stage IN ('call_booked', 'booking_complete')
                 AND ae.ts >= datetime('now', '-7 days')
                 AND EXISTS (
                     SELECT 1 FROM attribution_events ae2
                     WHERE ae2.chain_id = ae.chain_id
                     AND ae2.touch_type IN ('content_view', 'dm_trigger')
                     AND ae2.ts < ae.ts
                 )""",
            (brand,),
        ).fetchone()
        bookings_influenced = int(row[0]) if row else 0
    except Exception:
        pass

    return {
        "authority_score": auth.overall,
        "engagement_score": auth.engagement_score,
        "frequency_score": auth.frequency_score,
        "dm_trigger_score": auth.dm_trigger_score,
        "booking_influence_score": auth.booking_influence_score,
        "new_case_studies": len(case_studies),
        "content_queued_this_week": content_count,
        "bookings_influenced": bookings_influenced,
        "components": auth.components,
    }
