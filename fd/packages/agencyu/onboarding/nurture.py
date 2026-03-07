from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("agencyu.onboarding.nurture")

# Pre-call nurture schedule (AgencyU pattern):
#   +1h: case study matched to pain point
#   -24h: reminder (email/sms + DM)
#   -1h: reminder DM
# No-show rescue: +30m after missed call
NURTURE_STEPS = [
    {"name": "case_study", "delay_minutes": 60, "channel": "email"},
    {"name": "reminder_24h", "delay_minutes": -1440, "channel": "sms_email"},
    {"name": "reminder_1h", "delay_minutes": -60, "channel": "dm"},
]

NO_SHOW_RESCUE_DELAY_MINUTES = 30


def schedule_pre_call_nurture(
    conn: sqlite3.Connection,
    *,
    lead_id: str,
    correlation_id: str,
) -> dict[str, Any]:
    """Enqueue time-based nurture steps through the scheduled_actions table.

    Steps are executed by the nurture_tick job runner with rate limits.
    """
    now = utc_now_iso()
    scheduled: list[dict[str, Any]] = []

    for step in NURTURE_STEPS:
        payload = {
            "lead_id": lead_id,
            "step_name": step["name"],
            "channel": step["channel"],
            "delay_minutes": step["delay_minutes"],
        }

        if settings.DRY_RUN:
            scheduled.append({"action": "would_schedule", **payload})
            continue

        conn.execute(
            """INSERT INTO scheduled_actions
               (action_type, run_at_iso, payload_json, status, created_ts)
               VALUES (?, ?, ?, 'pending', ?)""",
            (
                "AGENCYU_NURTURE_SEND",
                now,
                json.dumps(payload),
                now,
            ),
        )
        scheduled.append({"action": "scheduled", **payload})

    if not settings.DRY_RUN:
        conn.commit()

    return {"ok": True, "lead_id": lead_id, "steps": scheduled}


def start_no_show_rescue(
    conn: sqlite3.Connection,
    *,
    lead_id: str,
    correlation_id: str,
) -> dict[str, Any]:
    """Schedule no-show rescue sequence (+30m after missed call)."""
    now = utc_now_iso()
    payload = {
        "lead_id": lead_id,
        "step_name": "no_show_rescue",
        "delay_minutes": NO_SHOW_RESCUE_DELAY_MINUTES,
    }

    if settings.DRY_RUN:
        return {"action": "would_schedule_no_show_rescue", **payload}

    conn.execute(
        """INSERT INTO scheduled_actions
           (action_type, run_at_iso, payload_json, status, created_ts)
           VALUES (?, ?, ?, 'pending', ?)""",
        (
            "AGENCYU_NO_SHOW_RESCUE",
            now,
            json.dumps(payload),
            now,
        ),
    )
    conn.commit()

    return {"action": "scheduled_no_show_rescue", **payload}
