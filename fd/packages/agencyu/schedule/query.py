"""Schedule Query — read-only helpers for the Today Command Center panel.

Provides:
  - get_today_schedule(): today's events with simple_mode dedup
  - count_overdue_deadlines(): overdue deadline count
  - list_overdue_deadlines(): overdue deadline list
  - Trello-feed-via-GCal suppression in simple_mode

Simple mode suppresses Google Calendar events that look like Trello
calendar feed duplicates (Trello boards subscribed into staff GCal).
"""
from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from packages.agencyu.schedule.models import ScheduleEvent
from packages.agencyu.schedule.repo import ScheduleRepo
from packages.common.logging import get_logger

log = get_logger("agencyu.schedule.query")

# Heuristic patterns for Trello-via-GCal feed events
_TRELLO_FEED_PATTERNS = [
    re.compile(r"trello", re.IGNORECASE),
    re.compile(r"\[.*\]\s+.+"),  # "[Board Name] Card Title" pattern
]
_TRELLO_URL_PATTERN = re.compile(r"trello\.com/c/([a-zA-Z0-9]+)", re.IGNORECASE)


def _looks_like_trello_feed(event: ScheduleEvent, trello_keys: set[str]) -> bool:
    """Heuristic: does this GCal event look like a Trello calendar feed item?

    Checks:
    1. Event title matches known Trello feed patterns
    2. Event notes/description contain a Trello card URL
    3. A Trello due entry exists for the same day with a similar title
    """
    if event.source != "gcal":
        return False

    title = event.title or ""
    notes = event.notes or ""

    # Check for Trello URL in notes
    url_match = _TRELLO_URL_PATTERN.search(notes)
    if url_match:
        return True

    # Check title patterns
    for pat in _TRELLO_FEED_PATTERNS:
        if pat.search(title):
            return True

    return False


def get_today_schedule(
    conn: sqlite3.Connection,
    *,
    brands: list[str] | None = None,
    limit: int = 20,
    simple_mode: bool = True,
) -> list[dict[str, Any]]:
    """Get today's schedule events for the Today panel.

    In simple_mode: suppresses GCal events that look like Trello feed duplicates.
    Returns dicts (not ScheduleEvent) for easy JSON serialization.
    """
    if brands is None:
        brands = ["fulldigital", "cutmv"]

    today = datetime.now(UTC).strftime("%Y-%m-%d")
    repo = ScheduleRepo(conn)

    all_events: list[ScheduleEvent] = []
    for brand in brands:
        all_events.extend(repo.get_day_events(brand, today))

    # Collect trello external keys for dedup
    trello_keys: set[str] = set()
    if simple_mode:
        trello_keys = {e.external_key or "" for e in all_events if e.source == "trello"}

    # Filter and format
    result: list[dict[str, Any]] = []
    for event in all_events:
        if simple_mode and _looks_like_trello_feed(event, trello_keys):
            continue

        result.append(_event_to_panel_dict(event))
        if len(result) >= limit:
            break

    return result


def count_overdue_deadlines(
    conn: sqlite3.Connection,
    brands: list[str] | None = None,
) -> int:
    """Count overdue deadlines (type=deadline, start < today, not completed/cancelled)."""
    if brands is None:
        brands = ["fulldigital", "cutmv"]

    today = datetime.now(UTC).strftime("%Y-%m-%d")
    placeholders = ",".join("?" for _ in brands)
    row = conn.execute(
        f"""SELECT COUNT(*) FROM schedule_events
            WHERE brand IN ({placeholders})
            AND event_type = 'deadline'
            AND date(start_time) < ?
            AND status NOT IN ('completed', 'cancelled')""",
        (*brands, today),
    ).fetchone()
    return row[0] if row else 0


def list_overdue_deadlines(
    conn: sqlite3.Connection,
    *,
    brands: list[str] | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """List overdue deadlines with details."""
    if brands is None:
        brands = ["fulldigital", "cutmv"]

    today = datetime.now(UTC).strftime("%Y-%m-%d")
    placeholders = ",".join("?" for _ in brands)
    rows = conn.execute(
        f"""SELECT * FROM schedule_events
            WHERE brand IN ({placeholders})
            AND event_type = 'deadline'
            AND date(start_time) < ?
            AND status NOT IN ('completed', 'cancelled')
            ORDER BY start_time ASC
            LIMIT ?""",
        (*brands, today, limit),
    ).fetchall()
    return [_row_to_panel_dict(r) for r in rows]


def get_next_up(
    conn: sqlite3.Connection,
    *,
    brands: list[str] | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Get the next N upcoming events from now (timed events first, then all-day)."""
    if brands is None:
        brands = ["fulldigital", "cutmv"]

    now = datetime.now(UTC).isoformat()
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    placeholders = ",".join("?" for _ in brands)

    # Timed events starting after now
    rows = conn.execute(
        f"""SELECT * FROM schedule_events
            WHERE brand IN ({placeholders})
            AND date(start_time) = ?
            AND all_day = 0
            AND start_time >= ?
            AND status NOT IN ('completed', 'cancelled')
            ORDER BY start_time ASC
            LIMIT ?""",
        (*brands, today, now, limit),
    ).fetchall()
    return [_row_to_panel_dict(r) for r in rows]


def get_today_schedule_focus(
    conn: sqlite3.Connection,
    *,
    brands: list[str] | None = None,
    focus_hours: int = 10,
    timezone: str = "America/New_York",
    include_all_day_deadlines: bool = True,
    all_day_type_allowlist: list[str] | None = None,
    max_items: int = 12,
    simple_mode: bool = True,
) -> dict[str, Any]:
    """Get today's schedule split into timed focus window + all-day deadlines.

    Returns:
        {
            "up_next": [...],          # timed events in [now, now+focus_hours)
            "deadlines": [...],        # allowlisted all-day items for today
            "focus_hours": int,
            "window_start": str,
            "window_end": str,
        }
    """
    if brands is None:
        brands = ["fulldigital", "cutmv"]
    if all_day_type_allowlist is None:
        all_day_type_allowlist = ["deadline"]

    try:
        tz = ZoneInfo(timezone)
    except Exception:
        tz = ZoneInfo("America/New_York")

    now_local = datetime.now(tz)
    today_str = now_local.strftime("%Y-%m-%d")

    # Window bounds in UTC for comparison with stored ISO timestamps
    window_start = now_local
    window_end = now_local + timedelta(hours=focus_hours)
    window_start_utc = window_start.astimezone(UTC).isoformat()
    window_end_utc = window_end.astimezone(UTC).isoformat()

    repo = ScheduleRepo(conn)

    # Collect all today events for Trello-feed dedup
    all_events: list[ScheduleEvent] = []
    for brand in brands:
        all_events.extend(repo.get_day_events(brand, today_str))

    trello_keys: set[str] = set()
    if simple_mode:
        trello_keys = {e.external_key or "" for e in all_events if e.source == "trello"}

    # Split into timed (up_next) vs all-day (deadlines)
    up_next: list[dict[str, Any]] = []
    deadlines: list[dict[str, Any]] = []

    for event in all_events:
        if simple_mode and _looks_like_trello_feed(event, trello_keys):
            continue

        if event.all_day:
            # Only include allowlisted event types
            if include_all_day_deadlines and event.event_type in all_day_type_allowlist:
                deadlines.append(_event_to_panel_dict(event))
        else:
            # Timed event: include if start_time falls within focus window
            if event.start_time:
                event_utc = event.start_time.isoformat()
                if window_start_utc <= event_utc < window_end_utc:
                    up_next.append(_event_to_panel_dict(event))

    # Sort timed by start_time
    up_next.sort(key=lambda x: x.get("start_time", ""))

    # Cap items
    up_next = up_next[:max_items]
    deadlines = deadlines[:max_items]

    return {
        "up_next": up_next,
        "deadlines": deadlines,
        "focus_hours": focus_hours,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
    }


def _event_to_panel_dict(event: ScheduleEvent) -> dict[str, Any]:
    """Convert ScheduleEvent to a dict for the Today panel."""
    time_str = ""
    if event.all_day:
        time_str = "All day"
    elif event.start_time:
        time_str = event.start_time.strftime("%H:%M")

    return {
        "id": event.id,
        "title": event.title,
        "brand": event.brand,
        "source": event.source,
        "event_type": event.event_type,
        "time": time_str,
        "start_time": event.start_time.isoformat() if event.start_time else "",
        "all_day": event.all_day,
        "status": event.status,
        "conflict": event.conflict_flag,
    }


def _row_to_panel_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Convert a raw DB row to a panel dict."""
    all_day = bool(row["all_day"])
    start = row["start_time"] or ""
    time_str = "All day" if all_day else start[11:16] if len(start) > 16 else ""

    return {
        "id": row["id"],
        "title": row["title"],
        "brand": row["brand"],
        "source": row["source"],
        "event_type": row["event_type"],
        "time": time_str,
        "start_time": start,
        "all_day": all_day,
        "status": row["status"],
        "conflict": bool(row["conflict_flag"]),
    }
