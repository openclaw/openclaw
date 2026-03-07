"""Notion Authority Writer — mirrors authority content queue + calendar to Notion.

Uses replace-between-markers to update OpenClaw-owned blocks.
Respects write_lock, cooldown, and idempotency.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.marketing.authority_scheduler import get_weekly_authority_report
from packages.agencyu.notion.mirror.block_markers import paragraph_block as _paragraph, wrap_with_markers
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.authority_writer")


def build_authority_blocks(
    conn: sqlite3.Connection,
    brand: str,
) -> list[dict[str, Any]]:
    """Build Notion blocks for the authority content section.

    Returns blocks wrapped with OPENCLAW markers for safe replacement.
    """
    report = get_weekly_authority_report(conn, brand)

    children: list[dict[str, Any]] = []

    # Authority score badge
    score = report.get("authority_score", 0)
    emoji = "🟢" if score >= 70 else "🟡" if score >= 40 else "🔴"
    children.append(_paragraph(f"{emoji} Authority Score: {score}/100"))

    # Component breakdown
    components = [
        f"Engagement: {report.get('engagement_score', 0):.0f}",
        f"Frequency: {report.get('frequency_score', 0):.0f}",
        f"DM Triggers: {report.get('dm_trigger_score', 0):.0f}",
        f"Booking Influence: {report.get('booking_influence_score', 0):.0f}",
    ]
    children.append(_paragraph(" · ".join(components)))

    # Content stats
    children.append(_paragraph(
        f"Content queued: {report.get('content_queued_this_week', 0)} | "
        f"Case studies: {report.get('new_case_studies', 0)} | "
        f"Bookings influenced: {report.get('bookings_influenced', 0)}"
    ))

    return wrap_with_markers("authority_dashboard", children)


def build_content_queue_blocks(
    conn: sqlite3.Connection,
    brand: str,
) -> list[dict[str, Any]]:
    """Build Notion blocks for the content queue."""
    children: list[dict[str, Any]] = []

    try:
        rows = conn.execute(
            """SELECT content_type, format, topic, status, priority, day_of_week
               FROM content_queue
               WHERE brand = ? AND status IN ('draft', 'review', 'scheduled')
               ORDER BY day_of_week, priority DESC
               LIMIT 15""",
            (brand,),
        ).fetchall()

        if rows:
            for r in rows:
                status_icon = {"draft": "📝", "review": "👀", "scheduled": "📅"}.get(r["status"], "·")
                pri = {"high": "🔴", "medium": "🟡", "low": "⚪"}.get(r["priority"], "")
                children.append(_paragraph(
                    f"{status_icon} {pri} Day {r['day_of_week']} — "
                    f"{r['content_type']} ({r['format']}): {r['topic'] or '—'}"
                ))
        else:
            children.append(_paragraph("No content items queued."))
    except Exception:
        children.append(_paragraph("Content queue data unavailable."))

    return wrap_with_markers("content_queue", children)


