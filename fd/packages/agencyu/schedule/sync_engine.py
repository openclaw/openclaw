"""Schedule Sync Engine — orchestrates unified schedule from all sources.

Pulls events from Trello (due dates), Google Calendar, and GHL appointments
into schedule_events. Detects conflicts. Builds daily plan cache.

Pipeline:
  Job 1 — schedule_pull_gcal: Pull Google Calendar → schedule_events → Notion
  Job 2 — schedule_pull_trello_due: Pull Trello due dates → schedule_events → Notion
  Job 3 — schedule_reconcile: Remove stale Notion mirror rows, repair schema

Idempotent: all sources use external_key dedup (source:id pattern).
Conflict policy: Google Calendar is master for time blocks,
Trello is master for deadlines. Overlaps create conflict_flag items.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.agencyu.schedule.models import DailyPlan, ScheduleEvent
from packages.agencyu.schedule.repo import DailyPlanRepo, GoalRepo, ScheduleRepo
from packages.common.logging import get_logger

log = get_logger("agencyu.schedule.sync_engine")


# ── Conflict detection ──


def detect_conflicts(events: list[ScheduleEvent]) -> list[tuple[ScheduleEvent, ScheduleEvent]]:
    """Detect time-overlap conflicts between timed (non-all-day) events.

    Returns pairs of conflicting events.
    """
    timed = [e for e in events if not e.all_day and e.end_time is not None]
    timed.sort(key=lambda e: e.start_time)

    conflicts: list[tuple[ScheduleEvent, ScheduleEvent]] = []
    for i in range(len(timed)):
        for j in range(i + 1, len(timed)):
            a, b = timed[i], timed[j]
            if a.end_time and b.start_time < a.end_time:
                conflicts.append((a, b))
            else:
                break  # sorted, no more overlaps for a
    return conflicts


def flag_conflicts(repo: ScheduleRepo, brand: str, day: str) -> int:
    """Detect and flag conflicts for a given day. Returns count of conflicts."""
    events = repo.get_day_events(brand, day)
    pairs = detect_conflicts(events)

    flagged_ids: set[int] = set()
    for a, b in pairs:
        if a.id:
            flagged_ids.add(a.id)
        if b.id:
            flagged_ids.add(b.id)

    if not flagged_ids:
        return 0

    for eid in flagged_ids:
        repo.conn.execute(
            "UPDATE schedule_events SET conflict_flag=1 WHERE id=?",
            (eid,),
        )
    repo.conn.commit()

    log.info("conflicts_flagged", extra={"brand": brand, "day": day, "count": len(flagged_ids)})
    return len(flagged_ids)


# ── Schedule summary ──


def build_schedule_summary(events: list[ScheduleEvent]) -> str:
    """Build a one-line schedule summary for the daily plan."""
    if not events:
        return "No events scheduled"

    deadlines = [e for e in events if e.event_type == "deadline"]
    meetings = [e for e in events if e.event_type in ("meeting", "appointment")]
    focus = [e for e in events if e.event_type == "focus_block"]
    conflicts = [e for e in events if e.conflict_flag]

    parts = []
    if meetings:
        parts.append(f"{len(meetings)} meeting{'s' if len(meetings) != 1 else ''}")
    if deadlines:
        parts.append(f"{len(deadlines)} deadline{'s' if len(deadlines) != 1 else ''}")
    if focus:
        parts.append(f"{len(focus)} focus block{'s' if len(focus) != 1 else ''}")
    if conflicts:
        parts.append(f"{len(conflicts)} conflict{'s' if len(conflicts) != 1 else ''}")

    return " \u2022 ".join(parts) if parts else "No events scheduled"


# ── Daily plan builder ──


def build_daily_plan(
    conn: sqlite3.Connection,
    brand: str,
    day: str | None = None,
) -> DailyPlan:
    """Build a complete daily plan for a brand, combining schedule + goals."""
    if day is None:
        day = datetime.now(UTC).strftime("%Y-%m-%d")

    schedule_repo = ScheduleRepo(conn)
    goal_repo = GoalRepo(conn)
    plan_repo = DailyPlanRepo(conn)

    events = schedule_repo.get_day_events(brand, day)
    flag_conflicts(schedule_repo, brand, day)
    events = schedule_repo.get_day_events(brand, day)

    summary = build_schedule_summary(events)

    goal_chip_obj = goal_repo.build_goal_chip(brand, "daily")
    goal_chip = goal_chip_obj.chip_text if goal_chip_obj else ""

    deadlines = [e for e in events if e.event_type == "deadline" and e.status == "scheduled"]
    top_priorities = [d.title for d in deadlines[:5]]

    conflict_events = [e for e in events if e.conflict_flag]
    blockers = [f"Conflict: {e.title}" for e in conflict_events[:3]]

    plan = DailyPlan(
        brand=brand,
        plan_date=day,
        goal_chip=goal_chip,
        schedule_summary=summary,
        top_priorities=top_priorities,
        blockers=blockers,
        status="active",
    )

    plan_repo.upsert(plan)
    return plan


def run_daily_sync(
    conn: sqlite3.Connection,
    brands: list[str] | None = None,
    day: str | None = None,
) -> dict[str, Any]:
    """Run the full daily sync for all brands.

    Builds daily plans (schedule + goals) for each brand.
    Source sync (Trello, GCal) should be called separately before this.
    """
    if brands is None:
        brands = ["fulldigital", "cutmv"]
    if day is None:
        day = datetime.now(UTC).strftime("%Y-%m-%d")

    results: dict[str, Any] = {"day": day, "plans": {}}

    for brand in brands:
        try:
            plan = build_daily_plan(conn, brand, day)
            results["plans"][brand] = {
                "ok": True,
                "goal_chip": plan.goal_chip,
                "schedule_summary": plan.schedule_summary,
                "top_priorities": plan.top_priorities,
                "blockers": plan.blockers,
            }
        except Exception as exc:
            log.warning("daily_sync_brand_error", extra={"brand": brand, "error": str(exc)})
            results["plans"][brand] = {"ok": False, "error": str(exc)}

    return results


# ── Sync run tracking ──


def record_sync_run(
    conn: sqlite3.Connection,
    job_name: str,
    source: str | None = None,
    brand: str | None = None,
) -> int:
    """Start a sync run record. Returns the run id."""
    cur = conn.execute(
        "INSERT INTO schedule_sync_runs (job_name, source, brand, status) VALUES (?, ?, ?, 'running')",
        (job_name, source, brand),
    )
    conn.commit()
    return cur.lastrowid or 0


def finish_sync_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    status: str = "success",
    events_synced: int = 0,
    events_removed: int = 0,
    errors: int = 0,
    details: dict[str, Any] | None = None,
) -> None:
    """Complete a sync run record."""
    conn.execute(
        """UPDATE schedule_sync_runs SET
             status=?, events_synced=?, events_removed=?, errors=?,
             details_json=?, finished_at=datetime('now')
           WHERE id=?""",
        (
            status,
            events_synced,
            events_removed,
            errors,
            json.dumps(details) if details else None,
            run_id,
        ),
    )
    conn.commit()


def get_last_sync_run(conn: sqlite3.Connection, job_name: str) -> dict[str, Any] | None:
    """Get the most recent sync run for a job."""
    row = conn.execute(
        "SELECT * FROM schedule_sync_runs WHERE job_name=? ORDER BY started_at DESC LIMIT 1",
        (job_name,),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def get_sync_history(conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    """Get recent sync run history."""
    rows = conn.execute(
        "SELECT * FROM schedule_sync_runs ORDER BY started_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


# ── Reconciliation (Job 3: drift healer) ──


def reconcile_schedule(
    conn: sqlite3.Connection,
    *,
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Drift healer for the schedule system.

    1. Removes stale Notion mirror rows if underlying events are cancelled
    2. Repairs missing required properties
    3. Enforces schema-lock discipline
    4. Clears stale conflict flags where no actual overlap exists

    Returns reconciliation summary.
    """
    repo = ScheduleRepo(conn)
    stale_cleared = 0
    conflicts_repaired = 0

    if safe_mode:
        # Dry run: count what would be cleaned
        stale_count = conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE status='cancelled' AND synced_to_notion=1",
        ).fetchone()[0]
        conflict_count = conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE conflict_flag=1 AND status != 'cancelled'",
        ).fetchone()[0]

        return {
            "ok": True,
            "dry_run": True,
            "stale_notion_rows": stale_count,
            "conflict_flags_to_recheck": conflict_count,
        }

    # Clear synced_to_notion on cancelled events (Notion mirror should remove them)
    cur = conn.execute(
        "UPDATE schedule_events SET synced_to_notion=0 WHERE status='cancelled' AND synced_to_notion=1",
    )
    stale_cleared = cur.rowcount

    # Re-validate conflict flags: clear flags on events that no longer overlap
    brands = ["fulldigital", "cutmv"]
    today = datetime.now(UTC).strftime("%Y-%m-%d")

    for brand in brands:
        events = repo.get_day_events(brand, today)
        flagged = [e for e in events if e.conflict_flag and e.id]
        actual_conflicts = detect_conflicts(events)
        actual_ids: set[int] = set()
        for a, b in actual_conflicts:
            if a.id:
                actual_ids.add(a.id)
            if b.id:
                actual_ids.add(b.id)

        for e in flagged:
            if e.id and e.id not in actual_ids:
                conn.execute(
                    "UPDATE schedule_events SET conflict_flag=0 WHERE id=?",
                    (e.id,),
                )
                conflicts_repaired += 1

    conn.commit()

    log.info("schedule_reconcile_complete", extra={
        "stale_cleared": stale_cleared,
        "conflicts_repaired": conflicts_repaired,
    })

    return {
        "ok": True,
        "dry_run": False,
        "stale_cleared": stale_cleared,
        "conflicts_repaired": conflicts_repaired,
    }
