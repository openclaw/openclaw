"""Daily Plan Writer — syncs daily_plan_cache to the Notion Daily Plan DB.

One row per brand per day. Includes goal chip, schedule summary,
top priorities, and blockers.

Safety:
- safe_mode: simulate all writes (return plan only)
- write_lock: always respected (forces safe_mode)
- Audit every write
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.agencyu.schedule.models import DailyPlan
from packages.agencyu.schedule.repo import DailyPlanRepo
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.daily_plan_writer")


class DailyPlanWriter:
    """Syncs daily_plan_cache rows to the Notion Daily Plan database."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        daily_plan_db_id: str,
        *,
        audit_writer: AuditWriter | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.daily_plan_db_id = daily_plan_db_id
        self.audit = audit_writer or AuditWriter(conn)
        self.state = SystemState(conn)
        self.plan_repo = DailyPlanRepo(conn)

    def sync_day(
        self,
        brand: str,
        day: str,
        *,
        safe_mode: bool = True,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Sync a daily plan to Notion.

        Creates or updates a row in the Daily Plan Notion DB.
        """
        effective_safe = safe_mode or self.state.write_lock_active()
        plan = self.plan_repo.get_today(brand, day)

        if not plan:
            return {"ok": True, "dry_run": effective_safe, "action": "skip", "reason": "no plan cached"}

        if effective_safe:
            return {
                "ok": True,
                "dry_run": True,
                "brand": brand,
                "day": day,
                "goal_chip": plan.goal_chip,
                "schedule_summary": plan.schedule_summary,
            }

        props = self._plan_to_properties(plan)
        action = "update" if plan.notion_page_id else "create"

        try:
            if plan.notion_page_id:
                self.notion.update_page(plan.notion_page_id, props)
            else:
                parent = {"database_id": self.daily_plan_db_id}
                page_id = self.notion.create_page(parent, props)
                # Store notion_page_id back
                self.conn.execute(
                    "UPDATE daily_plan_cache SET notion_page_id=?, synced_to_notion=1 WHERE brand=? AND plan_date=?",
                    (page_id, brand, day),
                )
                self.conn.commit()
        except Exception as exc:
            log.warning("daily_plan_writer_error", extra={
                "brand": brand, "day": day, "error": str(exc),
            })
            return {"ok": False, "error": str(exc)}

        self.audit.write_event(
            action="notion.daily_plan.sync",
            target_type="daily_plan_db",
            target_id=self.daily_plan_db_id,
            details={
                "brand": brand,
                "day": day,
                "action": action,
                "correlation_id": correlation_id,
            },
            correlation_id=correlation_id,
        )

        return {
            "ok": True,
            "dry_run": False,
            "brand": brand,
            "day": day,
            "action": action,
        }

    def _plan_to_properties(self, plan: DailyPlan) -> dict[str, Any]:
        """Convert a DailyPlan to Notion page properties."""
        title = f"{plan.brand} \u2022 {plan.plan_date}"
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": title}}]},
            "plan_date": {"date": {"start": plan.plan_date}},
            "status": {"select": {"name": plan.status.capitalize()}},
        }

        if plan.goal_chip:
            props["goal_chip"] = {"rich_text": [{"text": {"content": plan.goal_chip}}]}
        if plan.schedule_summary:
            props["schedule_summary"] = {"rich_text": [{"text": {"content": plan.schedule_summary}}]}
        if plan.top_priorities:
            props["top_priorities_json"] = {"rich_text": [{"text": {"content": json.dumps(plan.top_priorities)}}]}
        if plan.blockers:
            props["blockers_json"] = {"rich_text": [{"text": {"content": json.dumps(plan.blockers)}}]}

        return props
