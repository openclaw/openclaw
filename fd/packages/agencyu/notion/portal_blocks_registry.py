"""Portal blocks registry — stores OpenClaw-owned block IDs per portal page.

Avoids fragile "scan and guess" by pinning exact Notion block IDs
that OpenClaw created and owns in each client portal page.

Table: notion_portal_blocks
  PK: (portal_page_id, section_key)
  Stores: container_block_id (the callout), optional header_block_id
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.portal_blocks_registry")


@dataclass
class PortalBlockRecord:
    """A registered OpenClaw-owned block in a portal page."""

    portal_page_id: str
    section_key: str  # e.g. "start_here", "dropbox", "delivery"
    container_block_id: str  # the callout/toggle block OpenClaw owns
    header_block_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class PortalBlocksRegistry:
    """SQLite registry of Notion block IDs that OpenClaw owns in each portal page.

    Enables deterministic drift-healing without scanning page content.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def ensure_schema(self) -> None:
        """Create the notion_portal_blocks table if it doesn't exist."""
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS notion_portal_blocks (
                portal_page_id TEXT NOT NULL,
                section_key TEXT NOT NULL,
                container_block_id TEXT NOT NULL,
                header_block_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (portal_page_id, section_key)
            )
        """)
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_blocks_container "
            "ON notion_portal_blocks(container_block_id)"
        )
        self.conn.commit()

    def upsert(self, rec: PortalBlockRecord) -> None:
        """Insert or update a portal block record."""
        now = rec.updated_at or utc_now_iso()
        created = rec.created_at or now
        self.conn.execute(
            """INSERT INTO notion_portal_blocks
               (portal_page_id, section_key, container_block_id,
                header_block_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(portal_page_id, section_key) DO UPDATE SET
                 container_block_id=excluded.container_block_id,
                 header_block_id=excluded.header_block_id,
                 updated_at=excluded.updated_at""",
            (rec.portal_page_id, rec.section_key, rec.container_block_id,
             rec.header_block_id, created, now),
        )
        self.conn.commit()

    def get(self, portal_page_id: str, section_key: str) -> PortalBlockRecord | None:
        """Look up a single portal block record."""
        row = self.conn.execute(
            """SELECT portal_page_id, section_key, container_block_id,
                      header_block_id, created_at, updated_at
               FROM notion_portal_blocks
               WHERE portal_page_id=? AND section_key=?""",
            (portal_page_id, section_key),
        ).fetchone()
        if not row:
            return None
        return PortalBlockRecord(*row)

    def list_for_page(self, portal_page_id: str) -> list[PortalBlockRecord]:
        """List all registered blocks for a portal page."""
        rows = self.conn.execute(
            """SELECT portal_page_id, section_key, container_block_id,
                      header_block_id, created_at, updated_at
               FROM notion_portal_blocks
               WHERE portal_page_id=?
               ORDER BY section_key ASC""",
            (portal_page_id,),
        ).fetchall()
        return [PortalBlockRecord(*r) for r in rows]

    def delete(self, portal_page_id: str, section_key: str) -> None:
        """Remove a portal block record."""
        self.conn.execute(
            "DELETE FROM notion_portal_blocks WHERE portal_page_id=? AND section_key=?",
            (portal_page_id, section_key),
        )
        self.conn.commit()
