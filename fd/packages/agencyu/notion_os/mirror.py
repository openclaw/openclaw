from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.agencyu.canonical.hashing import stable_hash
from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion_os.drift import DriftResult, compute_drift
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("agencyu.notion_os.mirror")


class CanonicalNotionMirror:
    """Maps canonical entities into Notion pages with upsert + drift handling.

    Respects DRY_RUN, NOTION_WRITE_ENABLED, KILL_SWITCH.
    """

    def __init__(self, conn: sqlite3.Connection, notion: NotionClient) -> None:
        self.conn = conn
        self.notion = notion

    def _can_write(self) -> bool:
        return (
            settings.NOTION_WRITE_ENABLED
            and not settings.DRY_RUN
            and not settings.KILL_SWITCH
        )

    def sync_entity(
        self,
        *,
        entity_id: str,
        database_key: str,
        database_id: str,
        canonical_payload: dict[str, Any],
        notion_properties: dict[str, Any],
    ) -> dict[str, Any]:
        """Sync a single canonical entity to Notion.

        Returns sync result dict.
        """
        now = utc_now_iso()

        # Load existing mirror state
        state = self.conn.execute(
            "SELECT * FROM notion_mirror_state WHERE entity_id=?",
            (entity_id,),
        ).fetchone()

        page_id = state["notion_page_id"] if state else None
        last_hash = state["last_mirrored_hash"] if state else None
        locked = bool(state["locked"]) if state else False

        if locked:
            return {"skipped": True, "reason": "locked", "entity_id": entity_id}

        if not self._can_write():
            # Dry-run: compute drift but don't write
            content_hash = stable_hash(canonical_payload)
            drift_type = "unknown"
            if last_hash and content_hash == last_hash:
                drift_type = "none"
            elif last_hash:
                drift_type = "external"
            else:
                drift_type = "new"

            log.info("mirror_dry_run", extra={
                "entity_id": entity_id,
                "drift_type": drift_type,
                "action": "update" if page_id else "create",
            })
            return {
                "dry_run": True,
                "entity_id": entity_id,
                "action": "update" if page_id else "create",
                "drift_type": drift_type,
            }

        content_hash = stable_hash(canonical_payload)

        if page_id:
            # Update existing page
            self.notion.update_page(page_id, notion_properties)
            self._upsert_mirror_state(
                entity_id, database_key, database_id, page_id, content_hash, now,
            )
            return {"updated": True, "entity_id": entity_id, "notion_page_id": page_id}

        # Create new page
        created = self.notion.create_page(database_id, notion_properties)
        new_page_id = created.get("id", "")
        self._upsert_mirror_state(
            entity_id, database_key, database_id, new_page_id, content_hash, now,
        )
        return {"created": True, "entity_id": entity_id, "notion_page_id": new_page_id}

    def check_drift(self, entity_id: str, canonical_payload: dict[str, Any]) -> DriftResult:
        """Check drift for an entity without writing."""
        state = self.conn.execute(
            "SELECT * FROM notion_mirror_state WHERE entity_id=?",
            (entity_id,),
        ).fetchone()

        if not state or not state["notion_page_id"]:
            return DriftResult(has_drift=True, drift_type="external", details={"reason": "not_mirrored"})

        last_hash = state["last_mirrored_hash"]
        notion_snapshot = json.loads(state["last_notion_snapshot_json"] or "{}")

        return compute_drift(canonical_payload, notion_snapshot, last_hash)

    def get_mirror_stats(self) -> dict[str, Any]:
        """Get sync statistics."""
        total = self.conn.execute("SELECT COUNT(*) FROM notion_mirror_state").fetchone()[0]
        healthy = self.conn.execute(
            "SELECT COUNT(*) FROM notion_mirror_state WHERE sync_health='ok'"
        ).fetchone()[0]
        warning = self.conn.execute(
            "SELECT COUNT(*) FROM notion_mirror_state WHERE sync_health='warning'"
        ).fetchone()[0]
        broken = self.conn.execute(
            "SELECT COUNT(*) FROM notion_mirror_state WHERE sync_health='broken'"
        ).fetchone()[0]
        locked = self.conn.execute(
            "SELECT COUNT(*) FROM notion_mirror_state WHERE locked=1"
        ).fetchone()[0]

        return {
            "total_mirrored": total,
            "healthy": healthy,
            "warning": warning,
            "broken": broken,
            "locked": locked,
            "write_enabled": self._can_write(),
        }

    def _upsert_mirror_state(
        self,
        entity_id: str,
        database_key: str,
        database_id: str,
        page_id: str,
        content_hash: str,
        now: str,
    ) -> None:
        self.conn.execute(
            """INSERT INTO notion_mirror_state
               (entity_id, notion_database_key, notion_database_id, notion_page_id,
                last_mirrored_at, last_mirrored_hash, sync_health)
               VALUES (?, ?, ?, ?, ?, ?, 'ok')
               ON CONFLICT(entity_id) DO UPDATE SET
                 notion_page_id=excluded.notion_page_id,
                 last_mirrored_at=excluded.last_mirrored_at,
                 last_mirrored_hash=excluded.last_mirrored_hash,
                 sync_health='ok',
                 last_error=NULL""",
            (entity_id, database_key, database_id, page_id, now, content_hash),
        )
        self.conn.commit()
