"""Cross-system identity map store.

Wraps the existing `id_map`, `entity_mappings`, and `canonical_entities`
tables to provide a resolution chain across GHL, Trello, Stripe, QuickBooks,
ManyChat, and Notion.

Resolution priority: notion_page_id > ghl_contact_id > trello_card_id > manychat_user_id
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.identity_map")


class IdentityMapStore:
    """Unified identity resolution across external systems.

    Uses both the lightweight `id_map` table (domain + external_id → Notion page)
    and the richer `canonical_entities` / `entity_mappings` tables for full
    entity lifecycle management.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    # ─────────────────────────────────────────
    # Resolution
    # ─────────────────────────────────────────

    def resolve_notion_page_id(
        self,
        *,
        domain: str,
        external_id: str,
    ) -> str | None:
        """Resolve an external ID to a Notion page ID via id_map.

        Args:
            domain: Source system (e.g. "ghl", "trello", "stripe").
            external_id: The ID in that system.

        Returns:
            Notion page ID or None if not mapped.
        """
        row = self.conn.execute(
            "SELECT notion_page_id FROM id_map WHERE domain=? AND external_id=? LIMIT 1",
            (domain, external_id),
        ).fetchone()
        return row[0] if row and row[0] else None

    def resolve_by_ghl_contact(self, ghl_contact_id: str) -> str | None:
        """Find Notion page ID by GHL contact ID."""
        row = self.conn.execute(
            "SELECT notion_page_id FROM id_map WHERE ghl_contact_id=? AND notion_page_id IS NOT NULL LIMIT 1",
            (ghl_contact_id,),
        ).fetchone()
        return row[0] if row else None

    def resolve_by_trello_card(self, trello_card_id: str) -> str | None:
        """Find Notion page ID by Trello card ID."""
        row = self.conn.execute(
            "SELECT notion_page_id FROM id_map WHERE trello_card_id=? AND notion_page_id IS NOT NULL LIMIT 1",
            (trello_card_id,),
        ).fetchone()
        return row[0] if row else None

    def resolve_chain(
        self,
        *,
        ghl_contact_id: str | None = None,
        trello_card_id: str | None = None,
        manychat_user_id: str | None = None,
        domain: str | None = None,
        external_id: str | None = None,
    ) -> str | None:
        """Try multiple resolution strategies in priority order.

        Returns Notion page ID or None.
        """
        if domain and external_id:
            result = self.resolve_notion_page_id(domain=domain, external_id=external_id)
            if result:
                return result

        if ghl_contact_id:
            result = self.resolve_by_ghl_contact(ghl_contact_id)
            if result:
                return result

        if trello_card_id:
            result = self.resolve_by_trello_card(trello_card_id)
            if result:
                return result

        if manychat_user_id:
            row = self.conn.execute(
                "SELECT notion_page_id FROM id_map WHERE manychat_user_id=? AND notion_page_id IS NOT NULL LIMIT 1",
                (manychat_user_id,),
            ).fetchone()
            if row:
                return row[0]

        return None

    # ─────────────────────────────────────────
    # Upsert
    # ─────────────────────────────────────────

    def upsert_mapping(
        self,
        *,
        domain: str,
        external_id: str,
        notion_page_id: str | None = None,
        ghl_contact_id: str | None = None,
        trello_card_id: str | None = None,
        manychat_user_id: str | None = None,
    ) -> str:
        """Insert or update an identity mapping in id_map.

        Returns the id_map row ID.
        """
        now = utc_now_iso()
        row_id = new_id("idm")
        self.conn.execute(
            """INSERT INTO id_map
               (id, domain, external_id, notion_page_id, ghl_contact_id,
                trello_card_id, manychat_user_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(domain, external_id) DO UPDATE SET
                 notion_page_id=COALESCE(excluded.notion_page_id, id_map.notion_page_id),
                 ghl_contact_id=COALESCE(excluded.ghl_contact_id, id_map.ghl_contact_id),
                 trello_card_id=COALESCE(excluded.trello_card_id, id_map.trello_card_id),
                 manychat_user_id=COALESCE(excluded.manychat_user_id, id_map.manychat_user_id),
                 updated_at=excluded.updated_at""",
            (row_id, domain, external_id, notion_page_id, ghl_contact_id,
             trello_card_id, manychat_user_id, now, now),
        )
        self.conn.commit()
        return row_id

    # ─────────────────────────────────────────
    # Canonical entity management
    # ─────────────────────────────────────────

    def upsert_canonical_entity(
        self,
        *,
        entity_type: str,
        canonical_key: str,
        data: dict[str, Any],
    ) -> tuple[str, bool]:
        """Create or update a canonical entity.

        Returns (entity_id, is_new).
        Content hash is computed to detect changes.
        """
        now = utc_now_iso()
        data_json = json.dumps(data, sort_keys=True, ensure_ascii=False)
        content_hash = hashlib.sha256(data_json.encode()).hexdigest()[:16]

        existing = self.conn.execute(
            "SELECT id, content_hash FROM canonical_entities WHERE entity_type=? AND canonical_key=? LIMIT 1",
            (entity_type, canonical_key),
        ).fetchone()

        if existing:
            entity_id = existing[0]
            if existing[1] != content_hash:
                self.conn.execute(
                    """UPDATE canonical_entities
                       SET data_json=?, content_hash=?, last_seen_at=?, updated_at=?
                       WHERE id=?""",
                    (data_json, content_hash, now, now, entity_id),
                )
                self.conn.commit()
            return entity_id, False

        entity_id = new_id("ce")
        self.conn.execute(
            """INSERT INTO canonical_entities
               (id, entity_type, canonical_key, data_json, content_hash,
                last_seen_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (entity_id, entity_type, canonical_key, data_json, content_hash, now, now, now),
        )
        self.conn.commit()
        return entity_id, True

    def link_source(
        self,
        *,
        entity_id: str,
        source_system: str,
        source_type: str,
        source_id: str,
    ) -> None:
        """Link a source system ID to a canonical entity."""
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO entity_mappings
               (id, entity_id, source_system, source_type, source_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_system, source_type, source_id) DO UPDATE SET
                 entity_id=excluded.entity_id""",
            (new_id("em"), entity_id, source_system, source_type, source_id, now),
        )
        self.conn.commit()

    def get_mirror_state(self, entity_id: str) -> dict[str, Any] | None:
        """Get Notion mirror state for an entity."""
        row = self.conn.execute(
            "SELECT * FROM notion_mirror_state WHERE entity_id=?", (entity_id,)
        ).fetchone()
        if not row:
            return None
        return dict(row)

    def upsert_mirror_state(
        self,
        *,
        entity_id: str,
        database_key: str,
        notion_database_id: str | None = None,
        notion_page_id: str | None = None,
        content_hash: str | None = None,
        sync_health: str = "ok",
        error: str | None = None,
    ) -> None:
        """Update mirror state for an entity."""
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO notion_mirror_state
               (entity_id, notion_database_key, notion_database_id, notion_page_id,
                last_mirrored_at, last_mirrored_hash, sync_health, last_error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(entity_id) DO UPDATE SET
                 notion_database_id=COALESCE(excluded.notion_database_id, notion_mirror_state.notion_database_id),
                 notion_page_id=COALESCE(excluded.notion_page_id, notion_mirror_state.notion_page_id),
                 last_mirrored_at=excluded.last_mirrored_at,
                 last_mirrored_hash=COALESCE(excluded.last_mirrored_hash, notion_mirror_state.last_mirrored_hash),
                 sync_health=excluded.sync_health,
                 last_error=excluded.last_error""",
            (entity_id, database_key, notion_database_id, notion_page_id,
             now, content_hash, sync_health, error),
        )
        self.conn.commit()
