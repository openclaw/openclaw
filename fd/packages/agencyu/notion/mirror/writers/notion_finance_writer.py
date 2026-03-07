"""Mirror writer for Invoices and Expenses databases.

Source: Stripe paid/refunded events + QuickBooks summaries.
Target: Notion Invoices DB + Expenses DB.

Identity: stripe_invoice_id or qb_expense_id → canonical_key.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.finance")

INVOICES_DB_KEY = "invoices"
EXPENSES_DB_KEY = "expenses"


class NotionFinanceWriter:
    """Mirror writer: Stripe invoices + QB expenses → Notion finance DBs."""

    writer_name = "finance"

    def __init__(
        self,
        conn: sqlite3.Connection,
        invoices_db_id: str = "",
        expenses_db_id: str = "",
    ) -> None:
        self.conn = conn
        self.invoices_db_id = invoices_db_id
        self.expenses_db_id = expenses_db_id

    def collect_pending(self) -> list[dict[str, Any]]:
        """Collect invoice and expense entities that need sync."""
        rows = self.conn.execute(
            """SELECT ce.id, ce.entity_type, ce.canonical_key, ce.data_json, ce.content_hash
               FROM canonical_entities ce
               LEFT JOIN notion_mirror_state nms ON nms.entity_id = ce.id
               WHERE ce.entity_type IN ('invoice', 'expense')
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
        """Mirror a single invoice or expense to Notion."""
        import json

        entity_type = entity["entity_type"]
        if entity_type == "invoice":
            return self._mirror_invoice(entity, safe_mode=safe_mode, notion_api=notion_api, identity_store=identity_store)
        if entity_type == "expense":
            return self._mirror_expense(entity, safe_mode=safe_mode, notion_api=notion_api, identity_store=identity_store)
        return {"skipped": True, "reason": f"unknown_entity_type:{entity_type}"}

    def _mirror_invoice(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        import json

        entity_id = entity["id"]
        canonical_key = entity["canonical_key"]
        data = json.loads(entity["data_json"])
        content_hash = entity["content_hash"]

        name = data.get("description") or data.get("stripe_invoice_id") or canonical_key
        props = self._build_invoice_properties(data, name)

        existing_page_id = identity_store.resolve_chain(
            domain="invoice",
            external_id=canonical_key,
        )

        if safe_mode:
            action = "update" if existing_page_id else "create"
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.invoices_db_id:
            return {"error": "no_invoices_db_id", "entity_id": entity_id}

        if existing_page_id:
            notion_api.update_page(existing_page_id, props)
            identity_store.upsert_mirror_state(
                entity_id=entity_id,
                database_key=INVOICES_DB_KEY,
                notion_page_id=existing_page_id,
                content_hash=content_hash,
            )
            return {"updated": True, "notion_page_id": existing_page_id}

        parent = {"type": "database_id", "database_id": self.invoices_db_id}
        page_id = notion_api.create_page(parent, props)
        identity_store.upsert_mapping(
            domain="invoice",
            external_id=canonical_key,
            notion_page_id=page_id,
        )
        identity_store.upsert_mirror_state(
            entity_id=entity_id,
            database_key=INVOICES_DB_KEY,
            notion_database_id=self.invoices_db_id,
            notion_page_id=page_id,
            content_hash=content_hash,
        )
        return {"created": True, "notion_page_id": page_id}

    def _mirror_expense(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        import json

        entity_id = entity["id"]
        canonical_key = entity["canonical_key"]
        data = json.loads(entity["data_json"])
        content_hash = entity["content_hash"]

        name = data.get("description") or data.get("vendor") or canonical_key
        props = self._build_expense_properties(data, name)

        existing_page_id = identity_store.resolve_chain(
            domain="expense",
            external_id=canonical_key,
        )

        if safe_mode:
            action = "update" if existing_page_id else "create"
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.expenses_db_id:
            return {"error": "no_expenses_db_id", "entity_id": entity_id}

        if existing_page_id:
            notion_api.update_page(existing_page_id, props)
            identity_store.upsert_mirror_state(
                entity_id=entity_id,
                database_key=EXPENSES_DB_KEY,
                notion_page_id=existing_page_id,
                content_hash=content_hash,
            )
            return {"updated": True, "notion_page_id": existing_page_id}

        parent = {"type": "database_id", "database_id": self.expenses_db_id}
        page_id = notion_api.create_page(parent, props)
        identity_store.upsert_mapping(
            domain="expense",
            external_id=canonical_key,
            notion_page_id=page_id,
        )
        identity_store.upsert_mirror_state(
            entity_id=entity_id,
            database_key=EXPENSES_DB_KEY,
            notion_database_id=self.expenses_db_id,
            notion_page_id=page_id,
            content_hash=content_hash,
        )
        return {"created": True, "notion_page_id": page_id}

    def _build_invoice_properties(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name}}]},
        }
        if data.get("amount_cents") is not None:
            props["Amount"] = {"number": data["amount_cents"] / 100.0}
        if data.get("currency"):
            props["Currency"] = {"select": {"name": data["currency"].upper()}}
        if data.get("status"):
            props["Status"] = {"select": {"name": data["status"]}}
        if data.get("stripe_invoice_id"):
            props["stripe_invoice_id"] = {"rich_text": [{"text": {"content": data["stripe_invoice_id"]}}]}
        if data.get("stripe_customer_id"):
            props["stripe_customer_id"] = {"rich_text": [{"text": {"content": data["stripe_customer_id"]}}]}
        if data.get("paid_at"):
            props["Paid At"] = {"date": {"start": data["paid_at"]}}
        return props

    def _build_expense_properties(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name}}]},
        }
        if data.get("amount_cents") is not None:
            props["Amount"] = {"number": data["amount_cents"] / 100.0}
        if data.get("vendor"):
            props["Vendor"] = {"rich_text": [{"text": {"content": data["vendor"]}}]}
        if data.get("category"):
            props["Category"] = {"select": {"name": data["category"]}}
        if data.get("date"):
            props["Date"] = {"date": {"start": data["date"]}}
        if data.get("qb_expense_id"):
            props["qb_expense_id"] = {"rich_text": [{"text": {"content": data["qb_expense_id"]}}]}
        return props
