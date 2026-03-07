from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("momentum")

# Default momentum campaign parameters
DEFAULT_SPRINT_DAYS = 14
DEFAULT_TOUCHES_PER_WEEK = 3
MAX_TOUCHES_PER_SPRINT = 4
CONTACT_COOLDOWN_HOURS = 48


def build_warm_segment(
    conn: sqlite3.Connection,
    *,
    segment_type: str,
    max_age_days: int = 90,
) -> list[dict[str, Any]]:
    """Build a warm audience segment for momentum campaigns.

    Segment types: past_leads, no_shows, past_clients, upsell_eligible.
    Returns contacts matching the segment criteria.
    """
    cutoff = (datetime.now(tz=UTC) - timedelta(days=max_age_days)).isoformat()

    if segment_type == "past_leads":
        rows = conn.execute(
            """SELECT DISTINCT t.contact_key, MAX(t.ts) as last_ts
               FROM attribution_touchpoints t
               LEFT JOIN setter_activity_log s
                 ON t.contact_key = s.contact_key AND s.activity_type = 'booking'
               WHERE t.ts >= ? AND s.activity_id IS NULL
               GROUP BY t.contact_key
               ORDER BY last_ts DESC""",
            (cutoff,),
        ).fetchall()
    elif segment_type == "no_shows":
        cutoff_60 = (datetime.now(tz=UTC) - timedelta(days=60)).isoformat()
        rows = conn.execute(
            """SELECT DISTINCT contact_key, MAX(ts) as last_ts
               FROM setter_activity_log
               WHERE activity_type = 'no_show' AND ts >= ?
               GROUP BY contact_key
               ORDER BY last_ts DESC""",
            (cutoff_60,),
        ).fetchall()
    elif segment_type == "past_clients":
        rows = conn.execute(
            """SELECT DISTINCT contact_key, MAX(ts) as last_ts
               FROM revenue_attribution
               WHERE ts >= ?
               GROUP BY contact_key
               ORDER BY last_ts DESC""",
            (cutoff,),
        ).fetchall()
    else:
        return []

    return [{"contact_key": r["contact_key"], "last_touch": r["last_ts"]} for r in rows]


def generate_sprint_cadence(
    *,
    start_date: str,
    sprint_days: int = DEFAULT_SPRINT_DAYS,
    touches_per_week: int = DEFAULT_TOUCHES_PER_WEEK,
) -> list[dict[str, Any]]:
    """Generate a cadence schedule for a momentum sprint.

    Returns list of touch points with dates and touch numbers.
    """
    start = datetime.fromisoformat(start_date)
    touches: list[dict[str, Any]] = []
    days_between = max(1, 7 // touches_per_week)

    current_day = 0
    touch_num = 0
    while current_day < sprint_days and touch_num < MAX_TOUCHES_PER_SPRINT:
        touch_date = start + timedelta(days=current_day)
        touch_num += 1
        touch_type = _touch_type_for_number(touch_num)
        touches.append({
            "touch_number": touch_num,
            "date": touch_date.isoformat(),
            "day_offset": current_day,
            "touch_type": touch_type,
        })
        current_day += days_between

    return touches


def _touch_type_for_number(n: int) -> str:
    """Map touch number to type following give-give-give-ask pattern."""
    mapping = {
        1: "re_engage",
        2: "value_drop",
        3: "soft_ask",
        4: "direct_cta",
    }
    return mapping.get(n, "value_drop")


def schedule_momentum_sprint(
    conn: sqlite3.Connection,
    *,
    campaign_id: str,
    contacts: list[dict[str, Any]],
    start_date: str,
    sprint_days: int = DEFAULT_SPRINT_DAYS,
    touches_per_week: int = DEFAULT_TOUCHES_PER_WEEK,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Schedule a momentum campaign sprint for a list of contacts.

    Creates scheduled_actions for each touch, respecting stop rules.
    """
    cadence = generate_sprint_cadence(
        start_date=start_date,
        sprint_days=sprint_days,
        touches_per_week=touches_per_week,
    )

    scheduled = 0
    skipped = 0
    actions: list[dict[str, Any]] = []

    for contact in contacts:
        contact_key = contact.get("contact_key")
        if not contact_key:
            skipped += 1
            continue

        # Check cross-campaign cooldown
        if _recently_touched(conn, contact_key=contact_key, hours=CONTACT_COOLDOWN_HOURS):
            skipped += 1
            actions.append({"contact_key": contact_key, "action": "skipped_cooldown"})
            continue

        for touch in cadence:
            payload = {
                "campaign_id": campaign_id,
                "contact_key": contact_key,
                "touch_number": touch["touch_number"],
                "touch_type": touch["touch_type"],
            }

            if settings.DRY_RUN:
                actions.append({
                    "contact_key": contact_key,
                    "action": "would_schedule_touch",
                    "touch": touch["touch_number"],
                    "date": touch["date"],
                })
                scheduled += 1
                continue

            conn.execute(
                """INSERT INTO scheduled_actions
                   (action_type, run_at_iso, payload_json, status, created_ts)
                   VALUES (?, ?, ?, 'pending', ?)""",
                (
                    "MOMENTUM_TOUCH",
                    touch["date"],
                    json.dumps(payload, ensure_ascii=False),
                    datetime.now(tz=UTC).isoformat(),
                ),
            )
            scheduled += 1

    if not settings.DRY_RUN and scheduled > 0:
        conn.commit()
        write_audit(
            conn,
            action="momentum.sprint_scheduled",
            target=campaign_id,
            payload={"contacts": len(contacts), "scheduled": scheduled, "skipped": skipped},
            correlation_id=correlation_id,
        )

    return {
        "ok": True,
        "campaign_id": campaign_id,
        "scheduled": scheduled,
        "skipped": skipped,
        "actions": actions,
    }


def _recently_touched(
    conn: sqlite3.Connection,
    *,
    contact_key: str,
    hours: int,
) -> bool:
    """Check if contact was touched by any campaign recently."""
    cutoff = (datetime.now(tz=UTC) - timedelta(hours=hours)).isoformat()
    row = conn.execute(
        """SELECT id FROM scheduled_actions
           WHERE action_type='MOMENTUM_TOUCH'
             AND status IN ('pending', 'completed')
             AND payload_json LIKE ?
             AND created_ts >= ?
           LIMIT 1""",
        (f'%"contact_key": "{contact_key}"%', cutoff),
    ).fetchone()
    return row is not None


def get_pending_momentum_count(conn: sqlite3.Connection) -> int:
    """Count pending momentum touches."""
    row = conn.execute(
        "SELECT COUNT(*) FROM scheduled_actions WHERE action_type='MOMENTUM_TOUCH' AND status='pending'"
    ).fetchone()
    return int(row[0]) if row else 0
