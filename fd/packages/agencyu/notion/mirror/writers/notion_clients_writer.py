"""Mirror writer for Clients database.

Source: GHL contacts + Trello boards + Stripe customers.
Target: Notion Clients (Master) DB.

Identity: ghl_contact_id → client canonical_key.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.clients")

DATABASE_KEY = "clients"


class NotionClientsWriter:
    """Mirror writer: local client data → Notion Clients DB."""

    writer_name = "clients"

    def __init__(self, conn: sqlite3.Connection, notion_db_id: str = "") -> None:
        self.conn = conn
        self.notion_db_id = notion_db_id

    def collect_pending(self) -> list[dict[str, Any]]:
        """Collect client entities that need sync.

        Looks for canonical_entities of type 'client' that either:
        - Have no notion_mirror_state row, or
        - Have changed content_hash since last mirror.
        """
        rows = self.conn.execute(
            """SELECT ce.id, ce.canonical_key, ce.data_json, ce.content_hash
               FROM canonical_entities ce
               LEFT JOIN notion_mirror_state nms ON nms.entity_id = ce.id
               WHERE ce.entity_type = 'client'
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
        """Mirror a single client to Notion."""
        import json

        entity_id = entity["id"]
        canonical_key = entity["canonical_key"]
        data = json.loads(entity["data_json"])
        content_hash = entity["content_hash"]

        name = data.get("name") or data.get("company_name") or canonical_key
        props = self._build_properties(data, name)

        # Resolve existing Notion page
        existing_page_id = identity_store.resolve_chain(
            ghl_contact_id=data.get("ghl_contact_id"),
            trello_card_id=data.get("trello_board_id"),
            domain="client",
            external_id=canonical_key,
        )

        if safe_mode:
            action = "update" if existing_page_id else "create"
            log.info("clients_dry_run", extra={
                "entity_id": entity_id,
                "mirror_action": action,
                "client_name": name,
            })
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.notion_db_id:
            return {"error": "no_clients_db_id", "entity_id": entity_id}

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
            domain="client",
            external_id=canonical_key,
            notion_page_id=page_id,
            ghl_contact_id=data.get("ghl_contact_id"),
            trello_card_id=data.get("trello_board_id"),
        )
        identity_store.upsert_mirror_state(
            entity_id=entity_id,
            database_key=DATABASE_KEY,
            notion_database_id=self.notion_db_id,
            notion_page_id=page_id,
            content_hash=content_hash,
        )
        return {"created": True, "notion_page_id": page_id}

    def _build_properties(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name}}]},
        }
        field_map = {
            "ghl_contact_id": "ghl_contact_id",
            "trello_board_id": "trello_board_id",
            "stripe_customer_id": "stripe_customer_id",
            "stripe_subscription_id": "stripe_subscription_id",
            "email": "Email",
            "phone": "Phone",
            "company_name": "Company",
        }
        for data_key, prop_name in field_map.items():
            val = data.get(data_key)
            if val:
                props[prop_name] = {"rich_text": [{"text": {"content": str(val)}}]}

        if data.get("status"):
            props["Status"] = {"select": {"name": data["status"]}}
        if data.get("brand"):
            props["Brand"] = {"select": {"name": data["brand"]}}

        return props
