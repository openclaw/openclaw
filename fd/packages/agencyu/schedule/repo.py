"""Schedule & Goals repository — SQLite data layer.

Swappable: all DB access goes through this module.
Uses INSERT OR REPLACE with external_key for idempotent sync.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime

from packages.agencyu.schedule.models import DailyPlan, Goal, GoalChip, ScheduleEvent
from packages.common.logging import get_logger

log = get_logger("agencyu.schedule.repo")


class ScheduleRepo:
    """CRUD for schedule_events table."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def upsert(self, event: ScheduleEvent) -> int:
        """Insert or replace a schedule event by (source, external_key)."""
        now = datetime.utcnow().isoformat()
        cur = self.conn.execute(
            """INSERT INTO schedule_events
               (brand, source, external_key, event_type, title,
                start_time, end_time, all_day, location, attendees_json,
                trello_card_id, gcal_event_id, ghl_appointment_id,
                status, conflict_flag, notes, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source, external_key) DO UPDATE SET
                 title=excluded.title,
                 start_time=excluded.start_time,
                 end_time=excluded.end_time,
                 all_day=excluded.all_day,
                 location=excluded.location,
                 attendees_json=excluded.attendees_json,
                 status=excluded.status,
                 conflict_flag=excluded.conflict_flag,
                 notes=excluded.notes,
                 updated_at=excluded.updated_at""",
            (
                event.brand,
                event.source,
                event.external_key,
                event.event_type,
                event.title,
                event.start_time.isoformat(),
                event.end_time.isoformat() if event.end_time else None,
                int(event.all_day),
                event.location,
                json.dumps(event.attendees) if event.attendees else None,
                event.trello_card_id,
                event.gcal_event_id,
                event.ghl_appointment_id,
                event.status,
                int(event.conflict_flag),
                event.notes,
                now,
            ),
        )
        self.conn.commit()
        return cur.lastrowid or 0

    def get_day_events(self, brand: str, day: str) -> list[ScheduleEvent]:
        """Get all events for a brand on a given day (YYYY-MM-DD)."""
        rows = self.conn.execute(
            """SELECT * FROM schedule_events
               WHERE brand = ? AND date(start_time) = ?
               AND status != 'cancelled'
               ORDER BY all_day DESC, start_time ASC""",
            (brand, day),
        ).fetchall()
        return [self._row_to_event(r) for r in rows]

    def get_conflicts(self, brand: str) -> list[ScheduleEvent]:
        """Get events flagged as conflicts."""
        rows = self.conn.execute(
            """SELECT * FROM schedule_events
               WHERE brand = ? AND conflict_flag = 1
               AND status != 'cancelled'
               ORDER BY start_time ASC""",
            (brand,),
        ).fetchall()
        return [self._row_to_event(r) for r in rows]

    def mark_synced_to_notion(self, event_id: int, notion_page_id: str) -> None:
        """Mark an event as synced to Notion."""
        self.conn.execute(
            "UPDATE schedule_events SET synced_to_notion=1, notion_page_id=? WHERE id=?",
            (notion_page_id, event_id),
        )
        self.conn.commit()

    def delete_by_external_key(self, source: str, external_key: str) -> bool:
        """Soft-delete by marking as cancelled."""
        cur = self.conn.execute(
            "UPDATE schedule_events SET status='cancelled', updated_at=? WHERE source=? AND external_key=?",
            (datetime.utcnow().isoformat(), source, external_key),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def _row_to_event(self, row: sqlite3.Row) -> ScheduleEvent:
        attendees = json.loads(row["attendees_json"]) if row["attendees_json"] else []
        return ScheduleEvent(
            id=row["id"],
            brand=row["brand"],
            source=row["source"],
            external_key=row["external_key"],
            event_type=row["event_type"],
            title=row["title"],
            start_time=datetime.fromisoformat(row["start_time"]),
            end_time=datetime.fromisoformat(row["end_time"]) if row["end_time"] else None,
            all_day=bool(row["all_day"]),
            location=row["location"],
            attendees=attendees,
            trello_card_id=row["trello_card_id"],
            gcal_event_id=row["gcal_event_id"],
            ghl_appointment_id=row["ghl_appointment_id"],
            status=row["status"],
            conflict_flag=bool(row["conflict_flag"]),
            notes=row["notes"],
            notion_page_id=row["notion_page_id"],
        )


class GoalRepo:
    """CRUD for goals table."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def upsert(self, goal: Goal) -> int:
        """Insert or replace a goal by (brand, kpi_key, cadence)."""
        now = datetime.utcnow().isoformat()
        cur = self.conn.execute(
            """INSERT INTO goals
               (brand, kpi_key, cadence, target_value, current_value,
                progress_pct, status, start_date, end_date, notes, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(brand, kpi_key, cadence) DO UPDATE SET
                 target_value=excluded.target_value,
                 current_value=excluded.current_value,
                 progress_pct=excluded.progress_pct,
                 status=excluded.status,
                 notes=excluded.notes,
                 updated_at=excluded.updated_at""",
            (
                goal.brand,
                goal.kpi_key,
                goal.cadence,
                goal.target_value,
                goal.current_value,
                goal.progress_pct,
                goal.status,
                goal.start_date,
                goal.end_date,
                goal.notes,
                now,
            ),
        )
        self.conn.commit()
        return cur.lastrowid or 0

    def get_active(self, brand: str, cadence: str = "daily") -> list[Goal]:
        """Get active goals for a brand."""
        rows = self.conn.execute(
            """SELECT * FROM goals
               WHERE brand = ? AND cadence = ? AND status = 'active'
               ORDER BY kpi_key ASC""",
            (brand, cadence),
        ).fetchall()
        return [self._row_to_goal(r) for r in rows]

    def update_progress(self, brand: str, kpi_key: str, cadence: str, current_value: float) -> None:
        """Update current_value and progress_pct for a goal."""
        now = datetime.utcnow().isoformat()
        self.conn.execute(
            """UPDATE goals SET
                 current_value = ?,
                 progress_pct = CASE WHEN target_value > 0
                   THEN ROUND((? / target_value) * 100, 1)
                   ELSE 0 END,
                 updated_at = ?
               WHERE brand = ? AND kpi_key = ? AND cadence = ? AND status = 'active'""",
            (current_value, current_value, now, brand, kpi_key, cadence),
        )
        self.conn.commit()

    def build_goal_chip(self, brand: str, cadence: str = "daily") -> GoalChip | None:
        """Build a formatted goal chip for the primary KPI."""
        goals = self.get_active(brand, cadence)
        if not goals:
            return None
        g = goals[0]  # primary goal
        pct = round(g.progress_pct)
        kpi_label = _KPI_LABELS.get(g.kpi_key, g.kpi_key)
        chip = f"Goal \u2022 {int(g.target_value)} {kpi_label} \u2022 {pct}%"
        return GoalChip(
            brand=brand,
            kpi_key=g.kpi_key,
            target=g.target_value,
            current=g.current_value,
            progress_pct=g.progress_pct,
            chip_text=chip,
        )

    def _row_to_goal(self, row: sqlite3.Row) -> Goal:
        return Goal(
            id=row["id"],
            brand=row["brand"],
            kpi_key=row["kpi_key"],
            cadence=row["cadence"],
            target_value=row["target_value"],
            current_value=row["current_value"],
            progress_pct=row["progress_pct"],
            status=row["status"],
            start_date=row["start_date"],
            end_date=row["end_date"],
            notes=row["notes"],
        )


class DailyPlanRepo:
    """CRUD for daily_plan_cache table."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def upsert(self, plan: DailyPlan) -> int:
        """Insert or replace a daily plan by (brand, plan_date)."""
        now = datetime.utcnow().isoformat()
        cur = self.conn.execute(
            """INSERT INTO daily_plan_cache
               (brand, plan_date, goal_chip, schedule_summary,
                top_priorities_json, blockers_json, status, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(brand, plan_date) DO UPDATE SET
                 goal_chip=excluded.goal_chip,
                 schedule_summary=excluded.schedule_summary,
                 top_priorities_json=excluded.top_priorities_json,
                 blockers_json=excluded.blockers_json,
                 status=excluded.status,
                 updated_at=excluded.updated_at""",
            (
                plan.brand,
                plan.plan_date,
                plan.goal_chip,
                plan.schedule_summary,
                json.dumps(plan.top_priorities) if plan.top_priorities else None,
                json.dumps(plan.blockers) if plan.blockers else None,
                plan.status,
                now,
            ),
        )
        self.conn.commit()
        return cur.lastrowid or 0

    def get_today(self, brand: str, today: str) -> DailyPlan | None:
        """Get today's plan for a brand."""
        row = self.conn.execute(
            "SELECT * FROM daily_plan_cache WHERE brand=? AND plan_date=? LIMIT 1",
            (brand, today),
        ).fetchone()
        return self._row_to_plan(row) if row else None

    def _row_to_plan(self, row: sqlite3.Row) -> DailyPlan:
        return DailyPlan(
            id=row["id"],
            brand=row["brand"],
            plan_date=row["plan_date"],
            goal_chip=row["goal_chip"] or "",
            schedule_summary=row["schedule_summary"] or "",
            top_priorities=json.loads(row["top_priorities_json"]) if row["top_priorities_json"] else [],
            blockers=json.loads(row["blockers_json"]) if row["blockers_json"] else [],
            status=row["status"],
            notion_page_id=row["notion_page_id"],
        )


# KPI key → human label
_KPI_LABELS: dict[str, str] = {
    "calls_booked": "calls",
    "trials": "trials",
    "paid": "paid",
    "revenue": "revenue",
    "close_rate": "close rate",
}
