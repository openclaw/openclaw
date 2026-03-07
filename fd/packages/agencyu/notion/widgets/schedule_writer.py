"""Schedule Writer — syncs schedule_events to the Notion Schedule DB.

Uses external_key for idempotent upserts. Creates new rows for unseen events,
updates existing rows for known events.

Safety:
- safe_mode: simulate all writes (return plan only)
- write_lock: always respected (forces safe_mode)
- Audit every write
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.agencyu.schedule.models import ScheduleEvent
from packages.agencyu.schedule.repo import ScheduleRepo
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.schedule_writer")


class ScheduleWriter:
    """Syncs schedule_events rows to the Notion Schedule database."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        schedule_db_id: str,
        *,
        audit_writer: AuditWriter | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.schedule_db_id = schedule_db_id
        self.audit = audit_writer or AuditWriter(conn)
        self.state = SystemState(conn)
        self.repo = ScheduleRepo(conn)

    def sync_day(
        self,
        brand: str,
        day: str,
        *,
        safe_mode: bool = True,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Sync all schedule events for a given day to Notion.

        Creates or updates rows in the Schedule Notion DB.
        """
        effective_safe = safe_mode or self.state.write_lock_active()
        events = self.repo.get_day_events(brand, day)

        if effective_safe:
            return {
                "ok": True,
                "dry_run": True,
                "brand": brand,
                "day": day,
                "event_count": len(events),
            }

        created = 0
        updated = 0
        errors = 0

        for event in events:
            try:
                props = self._event_to_properties(event)
                if event.notion_page_id:
                    self.notion.update_page(event.notion_page_id, props)
                    updated += 1
                else:
                    parent = {"database_id": self.schedule_db_id}
                    page_id = self.notion.create_page(parent, props)
                    if event.id:
                        self.repo.mark_synced_to_notion(event.id, page_id)
                    created += 1
            except Exception as exc:
                log.warning("schedule_writer_event_error", extra={
                    "event_id": event.id, "error": str(exc),
                })
                errors += 1

        self.audit.write_event(
            action="notion.schedule.sync",
            target_type="schedule_db",
            target_id=self.schedule_db_id,
            details={
                "brand": brand,
                "day": day,
                "created": created,
                "updated": updated,
                "errors": errors,
                "correlation_id": correlation_id,
            },
            correlation_id=correlation_id,
        )

        log.info("schedule_sync_complete", extra={
            "brand": brand, "day": day,
            "created": created, "updated": updated, "errors": errors,
        })

        return {
            "ok": errors == 0,
            "dry_run": False,
            "brand": brand,
            "day": day,
            "created": created,
            "updated": updated,
            "errors": errors,
        }

    def _event_to_properties(self, event: ScheduleEvent) -> dict[str, Any]:
        """Convert a ScheduleEvent to Notion page properties."""
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": event.title}}]},
            "source": {"select": {"name": event.source}},
            "event_type": {"select": {"name": event.event_type}},
            "status": {"select": {"name": event.status.capitalize()}},
            "start_time": {"date": {"start": event.start_time.isoformat()}},
        }

        if event.external_key:
            props["external_key"] = {"rich_text": [{"text": {"content": event.external_key}}]}
        if event.end_time:
            props["start_time"]["date"]["end"] = event.end_time.isoformat()
        if event.all_day:
            props["all_day"] = {"checkbox": True}
        if event.location:
            props["location"] = {"rich_text": [{"text": {"content": event.location}}]}
        if event.attendees:
            props["attendees"] = {"rich_text": [{"text": {"content": ", ".join(event.attendees)}}]}
        if event.trello_card_id:
            props["trello_card_id"] = {"rich_text": [{"text": {"content": event.trello_card_id}}]}
        if event.gcal_event_id:
            props["gcal_event_id"] = {"rich_text": [{"text": {"content": event.gcal_event_id}}]}
        if event.ghl_appointment_id:
            props["ghl_appointment_id"] = {"rich_text": [{"text": {"content": event.ghl_appointment_id}}]}
        if event.conflict_flag:
            props["conflict_flag"] = {"checkbox": True}
        if event.notes:
            props["notes"] = {"rich_text": [{"text": {"content": event.notes}}]}

        return props
