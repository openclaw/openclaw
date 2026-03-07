from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from packages.agencyu.notion.client import NotionClient
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.schema_bootstrap")

# ── Database schemas (Notion property definitions) ──

CRM_PIPELINE_SCHEMA: dict[str, Any] = {
    "Name": {"title": {}},
    "Stage": {"select": {"options": [
        {"name": "new", "color": "gray"},
        {"name": "qualified", "color": "blue"},
        {"name": "booked", "color": "yellow"},
        {"name": "no_show", "color": "red"},
        {"name": "closed", "color": "green"},
        {"name": "nurture", "color": "purple"},
    ]}},
    "Source": {"select": {"options": [
        {"name": "meta_ad"},
        {"name": "organic_reel"},
        {"name": "story_reply"},
        {"name": "click_to_dm"},
    ]}},
    "Campaign": {"select": {}},
    "Revenue Tier": {"select": {}},
    "ghl_contact_id": {"rich_text": {}},
    "manychat_contact_id": {"rich_text": {}},
    "IG handle": {"rich_text": {}},
    "Email": {"email": {}},
    "Phone": {"phone_number": {}},
}

WORK_ORDERS_SCHEMA: dict[str, Any] = {
    "Name": {"title": {}},
    "Status": {"select": {"options": [
        {"name": "Requests", "color": "gray"},
        {"name": "In Progress", "color": "blue"},
        {"name": "Needs Review", "color": "yellow"},
        {"name": "Approved", "color": "green"},
        {"name": "Published", "color": "green"},
        {"name": "Delivered", "color": "green"},
    ]}},
    "Assigned To": {"rich_text": {}},
    "Due Date": {"date": {}},
    "Trello Card ID": {"rich_text": {}},
    "Board ID": {"rich_text": {}},
}

CLIENTS_SCHEMA: dict[str, Any] = {
    "Name": {"title": {}},
    "MRR": {"number": {"format": "dollar"}},
    "Status": {"select": {"options": [
        {"name": "active", "color": "green"},
        {"name": "onboarding", "color": "yellow"},
        {"name": "churned", "color": "red"},
    ]}},
    "ghl_contact_id": {"rich_text": {}},
    "Trello Board ID": {"rich_text": {}},
}

MEETINGS_SCHEMA: dict[str, Any] = {
    "Name": {"title": {}},
    "Date": {"date": {}},
    "Type": {"select": {"options": [
        {"name": "discovery"},
        {"name": "strategy"},
        {"name": "onboarding"},
    ]}},
    "Contact": {"rich_text": {}},
    "Outcome": {"select": {"options": [
        {"name": "completed"},
        {"name": "no_show"},
        {"name": "rescheduled"},
        {"name": "cancelled"},
    ]}},
}

DATABASES_TO_CREATE = [
    ("CRM Pipeline", CRM_PIPELINE_SCHEMA),
    ("Work Orders", WORK_ORDERS_SCHEMA),
    ("Clients", CLIENTS_SCHEMA),
    ("Meetings", MEETINGS_SCHEMA),
]


@dataclass
class NotionSchemaPlan:
    """Plan output for what the bootstrapper will create/bind."""
    databases: list[dict[str, Any]] = field(default_factory=list)
    bindings: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class NotionSchemaBootstrapper:
    """Creates or binds Notion databases for the AgencyOS workspace."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion: NotionClient,
        root_page_id: str | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion
        self.root_page_id = root_page_id or settings.NOTION_ROOT_PAGE_ID

    def plan(self) -> NotionSchemaPlan:
        """Generate a plan of what databases to create or bind."""
        result = NotionSchemaPlan()
        for title, schema in DATABASES_TO_CREATE:
            existing = self._get_binding(title)
            if existing:
                result.bindings.append({
                    "title": title,
                    "action": "already_bound",
                    "notion_object_id": existing["notion_object_id"],
                })
            else:
                result.databases.append({
                    "title": title,
                    "action": "will_create",
                    "properties_count": len(schema),
                })
        return result

    def execute(self) -> dict[str, Any]:
        """Create databases and save bindings. Respects DRY_RUN."""
        plan = self.plan()

        if settings.DRY_RUN:
            return {"dry_run": True, "plan": {
                "databases": plan.databases,
                "bindings": plan.bindings,
            }}

        if not settings.NOTION_WRITE_ENABLED:
            return {"skipped": True, "reason": "NOTION_WRITE_ENABLED=false"}

        if not self.root_page_id:
            return {"error": "NOTION_ROOT_PAGE_ID not set"}

        created = []
        for title, schema in DATABASES_TO_CREATE:
            existing = self._get_binding(title)
            if existing:
                log.info("database_already_bound", extra={"title": title})
                continue

            try:
                resp = self.notion.create_database(self.root_page_id, title, schema)
                db_id = resp.get("id", "")
                self._save_binding(title, db_id)
                created.append({"title": title, "notion_db_id": db_id})
                log.info("database_created", extra={"title": title, "db_id": db_id})
            except Exception as exc:
                log.error("database_create_failed", extra={"title": title, "error": str(exc)})
                plan.errors.append(f"{title}: {exc}")

        return {
            "created": created,
            "already_bound": [b for b in plan.bindings if b["action"] == "already_bound"],
            "errors": plan.errors,
        }

    def _get_binding(self, binding_type: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM notion_bindings WHERE binding_type=? LIMIT 1",
            (binding_type,),
        ).fetchone()
        return dict(row) if row else None

    def _save_binding(self, binding_type: str, notion_object_id: str) -> None:
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO notion_bindings (id, binding_type, notion_object_id, label, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(binding_type, notion_object_id) DO UPDATE SET
                 updated_at=excluded.updated_at""",
            (new_id("nb"), binding_type, notion_object_id, binding_type, now, now),
        )
        self.conn.commit()
