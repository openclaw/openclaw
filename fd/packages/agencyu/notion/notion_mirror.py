from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.agencyu.notion.client import NotionClient
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror")


@dataclass
class NotionMirrorConfig:
    """Controls what gets synced and safety gates."""
    sync_crm: bool = True
    sync_work_orders: bool = True
    sync_clients: bool = False
    write_enabled: bool = False


class NotionMirror:
    """Safe-mode mirror writer: Trello/GHL/DB → Notion pages.

    By default logs what it *would* do without writing.
    Set write_enabled=True (and NOTION_WRITE_ENABLED=True) to actually write.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion: NotionClient,
        config: NotionMirrorConfig | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion
        self.config = config or NotionMirrorConfig()

    def _can_write(self) -> bool:
        return (
            self.config.write_enabled
            and settings.NOTION_WRITE_ENABLED
            and not settings.DRY_RUN
            and not settings.KILL_SWITCH
        )

    def sync_work_order(
        self,
        *,
        trello_card_id: str,
        board_id: str,
        title: str,
        status: str,
        assigned_to: str | None = None,
        due_date: str | None = None,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Mirror a Trello work order card to Notion."""
        if not self.config.sync_work_orders:
            return {"skipped": True, "reason": "sync_work_orders=false"}

        now = utc_now_iso()

        # Check for existing mirror
        existing = self.conn.execute(
            "SELECT * FROM work_order_mirror WHERE trello_card_id=? LIMIT 1",
            (trello_card_id,),
        ).fetchone()

        props = {
            "Name": {"title": [{"text": {"content": title}}]},
            "Status": {"select": {"name": status}},
            "Trello Card ID": {"rich_text": [{"text": {"content": trello_card_id}}]},
            "Board ID": {"rich_text": [{"text": {"content": board_id}}]},
        }
        if assigned_to:
            props["Assigned To"] = {"rich_text": [{"text": {"content": assigned_to}}]}
        if due_date:
            props["Due Date"] = {"date": {"start": due_date}}

        if not self._can_write():
            log.info("mirror_dry_run", extra={
                "trello_card_id": trello_card_id,
                "action": "update" if existing else "create",
                "properties": list(props.keys()),
            })
            return {
                "dry_run": True,
                "action": "update" if existing else "create",
                "trello_card_id": trello_card_id,
                "title": title,
            }

        # Get work_orders DB binding
        db_binding = self.conn.execute(
            "SELECT notion_object_id FROM notion_bindings WHERE binding_type='Work Orders' LIMIT 1"
        ).fetchone()
        if not db_binding:
            return {"error": "no_work_orders_db_binding"}

        work_orders_db_id = db_binding["notion_object_id"]

        if existing and existing["notion_page_id"]:
            self.notion.update_page(existing["notion_page_id"], props)
            self._upsert_work_order_mirror(
                trello_card_id, existing["notion_page_id"], board_id,
                status, title, assigned_to, due_date, now,
            )
            return {"updated": True, "notion_page_id": existing["notion_page_id"]}

        created = self.notion.create_page(work_orders_db_id, props)
        notion_page_id = created.get("id", "")
        self._upsert_work_order_mirror(
            trello_card_id, notion_page_id, board_id,
            status, title, assigned_to, due_date, now,
        )
        return {"created": True, "notion_page_id": notion_page_id}

    def sync_crm_lead(
        self,
        *,
        lead_id: str,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Mirror a CRM lead from agencyu_leads to Notion."""
        if not self.config.sync_crm:
            return {"skipped": True, "reason": "sync_crm=false"}

        lead = self.conn.execute(
            "SELECT * FROM agencyu_leads WHERE id=? LIMIT 1", (lead_id,)
        ).fetchone()
        if not lead:
            return {"error": "lead_not_found", "lead_id": lead_id}

        name = lead["instagram_handle"] or lead["email"] or "Lead"
        stage = lead["stage"] or "new"

        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": name}}]},
            "Stage": {"select": {"name": stage}},
            "ghl_contact_id": {"rich_text": [{"text": {"content": lead["ghl_contact_id"] or ""}}]},
            "manychat_contact_id": {"rich_text": [{"text": {"content": lead["manychat_contact_id"] or ""}}]},
        }
        if lead["instagram_handle"]:
            props["IG handle"] = {"rich_text": [{"text": {"content": lead["instagram_handle"]}}]}
        if lead["email"]:
            props["Email"] = {"email": lead["email"]}
        if lead["campaign"]:
            props["Campaign"] = {"select": {"name": lead["campaign"]}}
        if lead["source"]:
            props["Source"] = {"select": {"name": lead["source"]}}

        if not self._can_write():
            log.info("crm_mirror_dry_run", extra={
                "lead_id": lead_id,
                "properties": list(props.keys()),
            })
            return {"dry_run": True, "lead_id": lead_id, "name": name}

        db_binding = self.conn.execute(
            "SELECT notion_object_id FROM notion_bindings WHERE binding_type='CRM Pipeline' LIMIT 1"
        ).fetchone()
        if not db_binding:
            return {"error": "no_crm_pipeline_db_binding"}

        crm_db_id = db_binding["notion_object_id"]

        # Check existing mirror
        existing_mirror = self.conn.execute(
            "SELECT * FROM notion_mirrors WHERE mirror_type='lead' AND lead_id=? LIMIT 1",
            (lead_id,),
        ).fetchone()

        if existing_mirror and existing_mirror["notion_page_id"]:
            self.notion.update_page(existing_mirror["notion_page_id"], props)
            return {"updated": True, "notion_page_id": existing_mirror["notion_page_id"]}

        created = self.notion.create_page(crm_db_id, props)
        page_id = created.get("id", "")
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO notion_mirrors
               (id, created_at, updated_at, mirror_type, ghl_contact_id, lead_id,
                notion_page_id, notion_db_id, last_sync_at, last_error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(mirror_type, notion_page_id) DO UPDATE SET
                 updated_at=excluded.updated_at, lead_id=excluded.lead_id,
                 last_sync_at=excluded.last_sync_at, last_error=NULL""",
            (new_id("nm"), now, now, "lead", lead["ghl_contact_id"],
             lead_id, page_id, crm_db_id, now, None),
        )
        self.conn.commit()
        return {"created": True, "notion_page_id": page_id}

    def get_sync_status(self) -> dict[str, Any]:
        """Return counts of mirrored records."""
        wom_count = self.conn.execute("SELECT COUNT(*) FROM work_order_mirror").fetchone()[0]
        nm_count = self.conn.execute("SELECT COUNT(*) FROM notion_mirrors").fetchone()[0]
        bindings = self.conn.execute("SELECT COUNT(*) FROM notion_bindings").fetchone()[0]
        return {
            "work_order_mirrors": wom_count,
            "notion_mirrors": nm_count,
            "bindings": bindings,
            "write_enabled": self._can_write(),
        }

    def _upsert_work_order_mirror(
        self,
        trello_card_id: str,
        notion_page_id: str,
        board_id: str,
        status: str,
        title: str,
        assigned_to: str | None,
        due_date: str | None,
        now: str,
    ) -> None:
        self.conn.execute(
            """INSERT INTO work_order_mirror
               (id, trello_card_id, notion_page_id, board_id, status, title,
                assigned_to, due_date, last_synced_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(trello_card_id) DO UPDATE SET
                 notion_page_id=excluded.notion_page_id,
                 status=excluded.status,
                 title=excluded.title,
                 assigned_to=excluded.assigned_to,
                 due_date=excluded.due_date,
                 last_synced_at=excluded.last_synced_at,
                 updated_at=excluded.updated_at""",
            (new_id("wom"), trello_card_id, notion_page_id, board_id,
             status, title, assigned_to, due_date, now, now, now),
        )
        self.conn.commit()
