from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("appointment_setter")


def log_setter_activity(
    conn: sqlite3.Connection,
    *,
    setter_id: str,
    activity_type: str,
    contact_key: str | None = None,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Record a setter activity (dm_sent, followup_sent, booking, no_show, etc.)."""
    activity_id = new_id("setter")
    ts = datetime.now(tz=UTC).isoformat()

    if settings.DRY_RUN:
        return {
            "action": "would_log_setter_activity",
            "activity_id": activity_id,
            "activity_type": activity_type,
        }

    conn.execute(
        """INSERT INTO setter_activity_log
           (activity_id, setter_id, activity_type, contact_key, details_json, ts)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            activity_id,
            setter_id,
            activity_type,
            contact_key,
            json.dumps(details or {}, ensure_ascii=False),
            ts,
        ),
    )
    conn.commit()

    write_audit(
        conn,
        action=f"setter.{activity_type}",
        target=contact_key or setter_id,
        payload={"activity_id": activity_id, "setter_id": setter_id},
        correlation_id=correlation_id,
    )

    return {"action": "activity_logged", "activity_id": activity_id, "activity_type": activity_type}


def log_dm_sent(
    conn: sqlite3.Connection,
    *,
    setter_id: str,
    contact_key: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Log a DM sent by a setter."""
    return log_setter_activity(
        conn,
        setter_id=setter_id,
        activity_type="dm_sent",
        contact_key=contact_key,
        correlation_id=correlation_id,
    )


def log_followup_sent(
    conn: sqlite3.Connection,
    *,
    setter_id: str,
    contact_key: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Log a follow-up sent by a setter."""
    return log_setter_activity(
        conn,
        setter_id=setter_id,
        activity_type="followup_sent",
        contact_key=contact_key,
        correlation_id=correlation_id,
    )


def log_booking(
    conn: sqlite3.Connection,
    *,
    setter_id: str,
    contact_key: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Log a booking made by a setter."""
    return log_setter_activity(
        conn,
        setter_id=setter_id,
        activity_type="booking",
        contact_key=contact_key,
        correlation_id=correlation_id,
    )


def compute_setter_kpis(
    conn: sqlite3.Connection,
    *,
    setter_id: str,
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    """Compute setter KPIs for a date range.

    Returns counts for: dms_sent, followups_sent, bookings, no_shows.
    """
    kpis: dict[str, int] = {}
    for activity_type in ("dm_sent", "followup_sent", "booking", "no_show"):
        row = conn.execute(
            """SELECT COUNT(*) FROM setter_activity_log
               WHERE setter_id=? AND activity_type=? AND ts >= ? AND ts <= ?""",
            (setter_id, activity_type, start_date, end_date),
        ).fetchone()
        kpis[activity_type] = int(row[0]) if row else 0

    dms = kpis["dm_sent"]
    bookings = kpis["booking"]
    no_shows = kpis["no_show"]
    showed = max(0, bookings - no_shows)

    return {
        "setter_id": setter_id,
        "period": {"start": start_date, "end": end_date},
        "dms_sent": dms,
        "followups_sent": kpis["followup_sent"],
        "bookings": bookings,
        "no_shows": no_shows,
        "showed": showed,
        "book_rate": round(bookings / dms, 4) if dms > 0 else 0.0,
        "show_rate": round(showed / bookings, 4) if bookings > 0 else 0.0,
    }


def get_hot_leads(
    conn: sqlite3.Connection,
    *,
    max_age_hours: int = 48,
    cooldown_hours: int = 24,
) -> list[dict[str, Any]]:
    """Return leads tagged qualified but not yet booked, engaged recently.

    Uses ghl_contact_index + setter_activity_log to determine recency.
    Returns a list of candidate leads (skeleton — real implementation
    will integrate with ManyChat tags and GHL contact data).
    """
    # Placeholder: in v1, this returns contacts from ghl_contact_index
    # that have setter activity within max_age_hours but no booking
    cutoff = (datetime.now(tz=UTC) - timedelta(hours=max_age_hours)).isoformat()
    cooldown_cutoff = (datetime.now(tz=UTC) - timedelta(hours=cooldown_hours)).isoformat()

    rows = conn.execute(
        """SELECT DISTINCT contact_key FROM setter_activity_log
           WHERE activity_type IN ('dm_sent', 'followup_sent')
             AND ts >= ?
             AND contact_key NOT IN (
               SELECT contact_key FROM setter_activity_log
               WHERE activity_type = 'booking' AND ts >= ?
             )
           ORDER BY ts DESC""",
        (cutoff, cutoff),
    ).fetchall()

    leads: list[dict[str, Any]] = []
    for r in rows:
        contact_key = r["contact_key"]
        if not contact_key:
            continue
        # Check cooldown: skip if last touch within cooldown window
        last_touch = conn.execute(
            """SELECT MAX(ts) as last_ts FROM setter_activity_log
               WHERE contact_key=? AND activity_type IN ('dm_sent', 'followup_sent')""",
            (contact_key,),
        ).fetchone()
        if last_touch and last_touch["last_ts"] and last_touch["last_ts"] > cooldown_cutoff:
            continue
        leads.append({"contact_key": contact_key, "last_activity": last_touch["last_ts"] if last_touch else None})

    return leads
