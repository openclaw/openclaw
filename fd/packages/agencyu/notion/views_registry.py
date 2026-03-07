"""Views Registry — API-safe view verification via Notion database contracts.

Notion API cannot reliably enumerate or verify user-created database views.
The Views Registry database stores required "view contracts" as rows so
OpenClaw can verify compliance deterministically.

Each ViewContract defines what filter/sort/layout a view should have.
The registry module can ensure contracts exist and update their status.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.views_registry")


@dataclass
class ViewContract:
    """A view contract defining what a required Notion view should contain."""

    view_key: str  # stable id e.g. "dash.ceo.active_clients"
    database_key: str  # logical DB key from manifest
    view_name: str  # human-readable name
    view_kind: str = "table"  # "board" | "table" | "gallery" | "linked_block"
    filter_spec: dict[str, Any] = field(default_factory=dict)
    sort_spec: dict[str, Any] = field(default_factory=dict)
    required: bool = True


class ViewsRegistry:
    """Manages view contracts in both SQLite and optional Notion Views Registry DB.

    Primary storage: SQLite views_registry table (authoritative).
    Secondary: Notion Views Registry database (visibility plane).
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: Any | None = None,
        notion_views_db_id: str | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.notion_views_db_id = notion_views_db_id

    def ensure_contract(self, vc: ViewContract, safe_mode: bool = True) -> dict[str, Any]:
        """Ensure a view contract exists in SQLite and optionally Notion.

        In safe_mode, only reports what would be done.
        """
        # Check if already exists in SQLite
        row = self.conn.execute(
            "SELECT id FROM views_registry WHERE database_key=? AND view_name=?",
            (vc.database_key, vc.view_name),
        ).fetchone()

        if row:
            return {"ok": True, "action": "noop", "view_key": vc.view_key}

        if safe_mode:
            return {"ok": True, "action": "simulate_create", "view_key": vc.view_key}

        # Insert into SQLite
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO views_registry
               (id, database_key, view_name, required, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'unknown', ?, ?)
               ON CONFLICT(database_key, view_name) DO UPDATE SET
                 required=excluded.required, updated_at=excluded.updated_at""",
            (new_id("vr"), vc.database_key, vc.view_name, int(vc.required), now, now),
        )
        self.conn.commit()

        # Optionally sync to Notion
        notion_page_id = None
        if self.notion and self.notion_views_db_id:
            try:
                notion_page_id = self.notion.create_page(
                    parent={"type": "database_id", "database_id": self.notion_views_db_id},
                    properties={
                        "name": {"title": [{"text": {"content": vc.view_name}}]},
                        "database_key": {"select": {"name": vc.database_key}},
                        "required": {"checkbox": vc.required},
                        "status": {"select": {"name": "unknown"}},
                        "system_managed": {"checkbox": True},
                    },
                )
            except Exception:
                log.debug("views_registry_notion_sync_skipped", exc_info=True)

        return {
            "ok": True,
            "action": "created",
            "view_key": vc.view_key,
            "notion_page_id": notion_page_id,
        }

    def ensure_all_from_manifest(
        self, manifest: dict[str, Any], safe_mode: bool = True
    ) -> list[dict[str, Any]]:
        """Ensure all required views from the manifest exist."""
        results: list[dict[str, Any]] = []
        databases = manifest.get("databases", {})

        for db_key, db_spec in databases.items():
            for view_name in db_spec.get("required_views", []):
                vc = ViewContract(
                    view_key=f"{db_key}.{view_name.lower().replace(' ', '_')}",
                    database_key=db_key,
                    view_name=view_name,
                )
                result = self.ensure_contract(vc, safe_mode=safe_mode)
                results.append(result)

        return results

    def update_status(
        self, database_key: str, view_name: str, status: str
    ) -> bool:
        """Update the status of a view contract. Returns True if updated."""
        now = utc_now_iso()
        try:
            cursor = self.conn.execute(
                """UPDATE views_registry SET status=?, last_verified_at=?, updated_at=?
                   WHERE database_key=? AND view_name=?""",
                (status, now, now, database_key, view_name),
            )
            self.conn.commit()
            return cursor.rowcount > 0
        except Exception:
            return False

    def get_required_views(self) -> list[dict[str, Any]]:
        """Get all required view contracts from SQLite."""
        try:
            rows = self.conn.execute(
                "SELECT * FROM views_registry WHERE required=1"
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []

    def get_missing_views(self) -> list[dict[str, Any]]:
        """Get required views with status 'missing' or 'unknown'."""
        try:
            rows = self.conn.execute(
                "SELECT * FROM views_registry WHERE required=1 AND status IN ('missing', 'unknown')"
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []
