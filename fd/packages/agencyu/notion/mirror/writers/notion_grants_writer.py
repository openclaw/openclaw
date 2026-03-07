"""Mirror writer for Grant Opportunities, Drafts, and Submissions databases.

Source: SQLite grant_opportunities / grant_drafts / grant_submissions tables.
Target: Notion databases under Finance -> GrantOps.

Follows the same pattern as NotionFinanceWriter:
  - collect_pending() finds entities needing sync (new or hash-changed)
  - mirror_one() creates or updates the Notion page
  - Identity map tracks external_id -> notion_page_id
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.grants")

OPPORTUNITIES_DB_KEY = "grant_opportunities"
DRAFTS_DB_KEY = "grant_drafts"
SUBMISSIONS_DB_KEY = "grant_submissions"


class NotionGrantsWriter:
    """Mirror writer: SQLite grant tables -> Notion grant databases."""

    writer_name = "grants"

    def __init__(
        self,
        conn: sqlite3.Connection,
        opportunities_db_id: str = "",
        drafts_db_id: str = "",
        submissions_db_id: str = "",
    ) -> None:
        self.conn = conn
        self.opportunities_db_id = opportunities_db_id
        self.drafts_db_id = drafts_db_id
        self.submissions_db_id = submissions_db_id

    def collect_pending(self) -> list[dict[str, Any]]:
        """Collect grant entities that need Notion sync."""
        entities: list[dict[str, Any]] = []

        # Opportunities
        for row in self.conn.execute(
            """SELECT id, 'opportunity' AS entity_type, external_id AS canonical_key,
                      name, content_hash
               FROM grant_opportunities
               WHERE content_hash != ''
               LIMIT 50"""
        ).fetchall():
            entities.append(dict(row))

        # Drafts
        for row in self.conn.execute(
            """SELECT id, 'grant_draft' AS entity_type, id AS canonical_key,
                      name, content_hash
               FROM grant_drafts
               WHERE content_hash != ''
               LIMIT 50"""
        ).fetchall():
            entities.append(dict(row))

        # Submissions
        for row in self.conn.execute(
            """SELECT id, 'grant_submission' AS entity_type, id AS canonical_key,
                      name, content_hash
               FROM grant_submissions
               WHERE content_hash != ''
               LIMIT 50"""
        ).fetchall():
            entities.append(dict(row))

        return entities

    def mirror_one(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        """Mirror a single grant entity to Notion."""
        entity_type = entity["entity_type"]
        if entity_type == "opportunity":
            return self._mirror_opportunity(entity, safe_mode=safe_mode, notion_api=notion_api, identity_store=identity_store)
        if entity_type == "grant_draft":
            return self._mirror_draft(entity, safe_mode=safe_mode, notion_api=notion_api, identity_store=identity_store)
        if entity_type == "grant_submission":
            return self._mirror_submission(entity, safe_mode=safe_mode, notion_api=notion_api, identity_store=identity_store)
        return {"skipped": True, "reason": f"unknown_entity_type:{entity_type}"}

    def _mirror_opportunity(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        entity_id = entity["id"]
        canonical_key = entity["canonical_key"]
        content_hash = entity["content_hash"]

        # Fetch full row
        row = self.conn.execute("SELECT * FROM grant_opportunities WHERE id = ?", (entity_id,)).fetchone()
        if not row:
            return {"skipped": True, "reason": "not_found"}
        data = dict(row)

        name = data.get("name", canonical_key)
        props = self._build_opportunity_properties(data, name)

        existing_page_id = identity_store.resolve_chain(domain="grant_opportunity", external_id=canonical_key)

        if safe_mode:
            action = "update" if existing_page_id else "create"
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.opportunities_db_id:
            return {"error": "no_opportunities_db_id", "entity_id": entity_id}

        if existing_page_id:
            notion_api.update_page(existing_page_id, props)
            return {"updated": True, "notion_page_id": existing_page_id}

        parent = {"type": "database_id", "database_id": self.opportunities_db_id}
        page_id = notion_api.create_page(parent, props)
        identity_store.upsert_mapping(domain="grant_opportunity", external_id=canonical_key, notion_page_id=page_id)
        return {"created": True, "notion_page_id": page_id}

    def _mirror_draft(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        entity_id = entity["id"]
        content_hash = entity["content_hash"]

        row = self.conn.execute("SELECT * FROM grant_drafts WHERE id = ?", (entity_id,)).fetchone()
        if not row:
            return {"skipped": True, "reason": "not_found"}
        data = dict(row)

        name = data.get("name", entity_id)
        props = self._build_draft_properties(data, name)

        existing_page_id = identity_store.resolve_chain(domain="grant_draft", external_id=entity_id)

        if safe_mode:
            action = "update" if existing_page_id else "create"
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.drafts_db_id:
            return {"error": "no_drafts_db_id", "entity_id": entity_id}

        if existing_page_id:
            notion_api.update_page(existing_page_id, props)
            return {"updated": True, "notion_page_id": existing_page_id}

        parent = {"type": "database_id", "database_id": self.drafts_db_id}
        page_id = notion_api.create_page(parent, props)
        identity_store.upsert_mapping(domain="grant_draft", external_id=entity_id, notion_page_id=page_id)
        return {"created": True, "notion_page_id": page_id}

    def _mirror_submission(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        entity_id = entity["id"]
        content_hash = entity["content_hash"]

        row = self.conn.execute("SELECT * FROM grant_submissions WHERE id = ?", (entity_id,)).fetchone()
        if not row:
            return {"skipped": True, "reason": "not_found"}
        data = dict(row)

        name = data.get("name", entity_id)
        props = self._build_submission_properties(data, name)

        existing_page_id = identity_store.resolve_chain(domain="grant_submission", external_id=entity_id)

        if safe_mode:
            action = "update" if existing_page_id else "create"
            return {"dry_run": True, "action": action, "entity_id": entity_id}

        if not self.submissions_db_id:
            return {"error": "no_submissions_db_id", "entity_id": entity_id}

        if existing_page_id:
            notion_api.update_page(existing_page_id, props)
            return {"updated": True, "notion_page_id": existing_page_id}

        parent = {"type": "database_id", "database_id": self.submissions_db_id}
        page_id = notion_api.create_page(parent, props)
        identity_store.upsert_mapping(domain="grant_submission", external_id=entity_id, notion_page_id=page_id)
        return {"created": True, "notion_page_id": page_id}

    # ── Property builders ──

    def _build_opportunity_properties(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name[:100]}}]},
        }
        if data.get("funder"):
            props["Funder"] = {"rich_text": [{"text": {"content": data["funder"][:100]}}]}
        if data.get("deadline"):
            props["Deadline"] = {"date": {"start": data["deadline"][:10]}}
        if data.get("amount_min_usd") is not None:
            props["Amount Min"] = {"number": data["amount_min_usd"]}
        if data.get("amount_max_usd") is not None:
            props["Amount Max"] = {"number": data["amount_max_usd"]}
        if data.get("fit_score") is not None:
            props["Fit Score"] = {"number": data["fit_score"]}
        if data.get("effort_score") is not None:
            props["Effort Score"] = {"number": data["effort_score"]}
        if data.get("priority"):
            props["Priority"] = {"select": {"name": data["priority"]}}
        if data.get("status"):
            props["Status"] = {"select": {"name": data["status"]}}
        if data.get("portal_type"):
            props["Portal Type"] = {"select": {"name": data["portal_type"]}}
        if data.get("portal_url"):
            props["Portal URL"] = {"url": data["portal_url"]}
        if data.get("source"):
            props["Source"] = {"select": {"name": data["source"]}}
        if data.get("brand"):
            props["Brand"] = {"select": {"name": data["brand"]}}
        if data.get("external_id"):
            props["External ID"] = {"rich_text": [{"text": {"content": data["external_id"]}}]}
        return props

    def _build_draft_properties(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name[:100]}}]},
        }
        if data.get("status"):
            props["Status"] = {"select": {"name": data["status"]}}
        if data.get("attachments_ready") is not None:
            props["Attachments Ready"] = {"checkbox": bool(data["attachments_ready"])}
        if data.get("reviewer"):
            props["Reviewer"] = {"rich_text": [{"text": {"content": data["reviewer"]}}]}
        if data.get("created_at"):
            props["Created At"] = {"date": {"start": data["created_at"][:10]}}
        return props

    def _build_submission_properties(self, data: dict[str, Any], name: str) -> dict[str, Any]:
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name[:100]}}]},
        }
        if data.get("method"):
            props["Method"] = {"select": {"name": data["method"]}}
        if data.get("status"):
            props["Status"] = {"select": {"name": data["status"]}}
        if data.get("submitted_at"):
            props["Submitted At"] = {"date": {"start": data["submitted_at"][:10]}}
        if data.get("confirmation_id"):
            props["Confirmation ID"] = {"rich_text": [{"text": {"content": data["confirmation_id"]}}]}
        if data.get("blocker_reason"):
            props["Blocker Reason"] = {"rich_text": [{"text": {"content": data["blocker_reason"][:200]}}]}
        if data.get("follow_up_date"):
            props["Follow Up Date"] = {"date": {"start": data["follow_up_date"][:10]}}
        if data.get("outcome"):
            props["Outcome"] = {"select": {"name": data["outcome"]}}
        if data.get("award_amount_usd") is not None:
            props["Award Amount"] = {"number": data["award_amount_usd"]}
        return props
