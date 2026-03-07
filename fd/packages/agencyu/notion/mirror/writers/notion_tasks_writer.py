"""Mirror writer for Tasks database.

Source: Trello cards (from work_order_mirror or canonical_entities).
Target: Notion Tasks DB.

Identity: trello_card_id → task canonical_key.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.tasks")

DATABASE_KEY = "tasks"


class NotionTasksWriter:
    """Mirror writer: local task data → Notion Tasks DB."""

    writer_name = "tasks"

    def __init__(self, conn: sqlite3.Connection, notion_db_id: str = "") -> None:
        self.conn = conn
        self.notion_db_id = notion_db_id

    def collect_pending(self) -> list[dict[str, Any]]:
        """Collect task entities that need sync."""
        rows = self.conn.execute(
            """SELECT ce.id, ce.canonical_key, ce.data_json, ce.content_hash
               FROM canonical_entities ce
               LEFT JOIN notion_mirror_state nms ON nms.entity_id = ce.id
               WHERE ce.entity_type = 'task'
                 AND ce.is_deleted = 0
                 AND (nms.entity_id IS NULL
                      OR nms.last_mirrored_hash != ce.content_hash
                      OR nms.sync_health = 'error')
               LIMIT 100"""
        ).fetchall()
        return [dict(r) for r in rows]

    def mirror_one(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        """Mirror a single task to Notion."""
        import json

        entity_id = entity["id"]
        canonical_key = entity["canonical_key"]
        data = json.loads(entity["data_json"])
        content_hash = entity["content_hash"]

        title = data.get("title") or data.get("name") or canonical_key
        props = self._build_properties(data, title)

        existing_page_id = identity_store.resolve_chain(
            trello_card_id=data.get("trello_card_id"),
            domain="task",
            external_id=canonical_key,
        )

        if safe_mode:
            action = "update" if existing_page_id else "create"
            log.info("tasks_dry_run", extra={
                "entity_id": entity_id,
                "mirror_action": action,
                "task_title": title,
            })
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.notion_db_id:
            return {"error": "no_tasks_db_id", "entity_id": entity_id}

        if existing_page_id:
            notion_api.update_page(existing_page_id, props)
            identity_store.upsert_mirror_state(
                entity_id=entity_id,
                database_key=DATABASE_KEY,
                notion_page_id=existing_page_id,
                content_hash=content_hash,
            )
            return {"updated": True, "notion_page_id": existing_page_id}

        parent = {"type": "database_id", "database_id": self.notion_db_id}
        page_id = notion_api.create_page(parent, props)
        identity_store.upsert_mapping(
            domain="task",
            external_id=canonical_key,
            trello_card_id=data.get("trello_card_id"),
            notion_page_id=page_id,
        )
        identity_store.upsert_mirror_state(
            entity_id=entity_id,
            database_key=DATABASE_KEY,
            notion_database_id=self.notion_db_id,
            notion_page_id=page_id,
            content_hash=content_hash,
        )
        return {"created": True, "notion_page_id": page_id}

    def _build_properties(self, data: dict[str, Any], title: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": title}}]},
        }
        if data.get("status"):
            props["Status"] = {"select": {"name": data["status"]}}
        if data.get("assigned_to"):
            props["Assigned To"] = {"rich_text": [{"text": {"content": data["assigned_to"]}}]}
        if data.get("due_date"):
            props["Due Date"] = {"date": {"start": data["due_date"]}}
        if data.get("priority"):
            props["Priority"] = {"select": {"name": data["priority"]}}
        if data.get("trello_card_id"):
            props["Trello Card ID"] = {"rich_text": [{"text": {"content": data["trello_card_id"]}}]}
        if data.get("board_id"):
            props["Board ID"] = {"rich_text": [{"text": {"content": data["board_id"]}}]}
        return props
