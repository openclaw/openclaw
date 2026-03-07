from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("nurture")

# Default nurture schedule: offsets in hours from booking creation
DEFAULT_NURTURE_SCHEDULE = [
    {"offset_hours": 0, "asset_type": "confirmation", "channel": "sms_email"},
    {"offset_hours": 2, "asset_type": "vsl", "channel": "email"},
    {"offset_hours": 24, "asset_type": "case_study_1", "channel": "email"},
    {"offset_hours": 48, "asset_type": "social_proof", "channel": "sms"},
]

# Stop statuses: if contact reaches any of these, cancel remaining nurture
STOP_STATUSES = {"closed_won", "closed_lost", "booking_cancelled", "opt_out"}


def schedule_pre_call_nurture(
    conn: sqlite3.Connection,
    *,
    booking_id: str,
    contact_key: str,
    call_time_iso: str | None = None,
    segment: str = "starter",
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Schedule nurture actions for a booking.

    Creates scheduled_actions rows for each nurture step.
    """
    booked_at = datetime.now(tz=UTC)
    actions_created: list[dict[str, Any]] = []

    for step in DEFAULT_NURTURE_SCHEDULE:
        run_at = booked_at + timedelta(hours=step["offset_hours"])
        action_payload = {
            "booking_id": booking_id,
            "contact_key": contact_key,
            "asset_type": step["asset_type"],
            "channel": step["channel"],
            "segment": segment,
        }

        if settings.DRY_RUN:
            actions_created.append({
                "action": "would_schedule_nurture",
                "asset_type": step["asset_type"],
                "run_at": run_at.isoformat(),
            })
            continue

        conn.execute(
            """INSERT INTO scheduled_actions
               (action_type, run_at_iso, payload_json, status, created_ts)
               VALUES (?, ?, ?, 'pending', ?)""",
            (
                "NURTURE_SEND",
                run_at.isoformat(),
                json.dumps(action_payload, ensure_ascii=False),
                booked_at.isoformat(),
            ),
        )
        actions_created.append({
            "action": "nurture_scheduled",
            "asset_type": step["asset_type"],
            "run_at": run_at.isoformat(),
        })

    if not settings.DRY_RUN:
        conn.commit()
        write_audit(
            conn,
            action="nurture.scheduled",
            target=contact_key,
            payload={"booking_id": booking_id, "steps": len(actions_created)},
            correlation_id=correlation_id,
        )

    return {
        "ok": True,
        "booking_id": booking_id,
        "contact_key": contact_key,
        "actions": actions_created,
        "count": len(actions_created),
    }


def should_stop_nurture(
    conn: sqlite3.Connection,
    *,
    contact_key: str,
) -> str | None:
    """Check if nurture should be stopped for a contact.

    Returns the stop reason or None if nurture should continue.
    """
    # Check lead_attribution for closed status
    la = conn.execute(
        """SELECT t.touch_type FROM attribution_touchpoints t
           WHERE t.contact_key=? ORDER BY t.ts DESC LIMIT 1""",
        (contact_key,),
    ).fetchone()

    if la and la["touch_type"] in STOP_STATUSES:
        return la["touch_type"]

    # Check setter_activity_log for booking_cancelled
    cancel = conn.execute(
        """SELECT activity_id FROM setter_activity_log
           WHERE contact_key=? AND activity_type='booking_cancelled'
           ORDER BY ts DESC LIMIT 1""",
        (contact_key,),
    ).fetchone()

    if cancel:
        return "booking_cancelled"

    return None


def cancel_pending_nurture(
    conn: sqlite3.Connection,
    *,
    contact_key: str,
    reason: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Cancel all pending nurture actions for a contact."""
    if settings.DRY_RUN:
        return {"action": "would_cancel_nurture", "contact_key": contact_key, "reason": reason}

    # Find pending NURTURE_SEND actions for this contact
    rows = conn.execute(
        """SELECT id, payload_json FROM scheduled_actions
           WHERE action_type='NURTURE_SEND' AND status='pending'"""
    ).fetchall()

    cancelled = 0
    for r in rows:
        try:
            payload = json.loads(r["payload_json"])
            if payload.get("contact_key") == contact_key:
                conn.execute(
                    "UPDATE scheduled_actions SET status='cancelled', updated_ts=? WHERE id=?",
                    (datetime.now(tz=UTC).isoformat(), r["id"]),
                )
                cancelled += 1
        except (json.JSONDecodeError, KeyError):
            continue

    if cancelled > 0:
        conn.commit()
        write_audit(
            conn,
            action="nurture.cancelled",
            target=contact_key,
            payload={"reason": reason, "cancelled_count": cancelled},
            correlation_id=correlation_id,
        )

    return {"action": "nurture_cancelled", "contact_key": contact_key, "cancelled": cancelled, "reason": reason}


def get_pending_nurture_count(conn: sqlite3.Connection) -> int:
    """Count pending nurture actions."""
    row = conn.execute(
        "SELECT COUNT(*) FROM scheduled_actions WHERE action_type='NURTURE_SEND' AND status='pending'"
    ).fetchone()
    return int(row[0]) if row else 0
