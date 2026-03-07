from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.agencyu.canonical.hashing import stable_hash
from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.canonical.mapper")


def upsert_canonical_entity(
    conn: sqlite3.Connection,
    *,
    entity_type: str,
    canonical_key: str | None,
    data: dict[str, Any],
    source_system: str,
    source_type: str,
    source_id: str,
) -> str:
    """Upsert a canonical entity and its source mapping.

    Returns the canonical entity ID.
    """
    content_hash = stable_hash(data)
    now = utc_now_iso()

    # Check if mapping already exists
    existing_mapping = conn.execute(
        "SELECT entity_id FROM entity_mappings WHERE source_system=? AND source_type=? AND source_id=?",
        (source_system, source_type, source_id),
    ).fetchone()

    if existing_mapping:
        entity_id = existing_mapping["entity_id"]
        conn.execute(
            """UPDATE canonical_entities SET
                 data_json=?, content_hash=?, last_seen_at=?, updated_at=?,
                 canonical_key=COALESCE(?, canonical_key)
               WHERE id=?""",
            (json.dumps(data), content_hash, now, now, canonical_key, entity_id),
        )
        conn.commit()
        log.info("canonical_entity_updated", extra={"entity_id": entity_id, "entity_type": entity_type})
        return entity_id

    # Create new entity + mapping
    entity_id = new_id("ce")
    conn.execute(
        """INSERT INTO canonical_entities
           (id, entity_type, canonical_key, data_json, content_hash, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (entity_id, entity_type, canonical_key, json.dumps(data), content_hash, now, now, now),
    )
    mapping_id = new_id("em")
    conn.execute(
        """INSERT INTO entity_mappings (id, entity_id, source_system, source_type, source_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (mapping_id, entity_id, source_system, source_type, source_id, now),
    )
    conn.commit()
    log.info("canonical_entity_created", extra={"entity_id": entity_id, "entity_type": entity_type})
    return entity_id


def get_canonical_entity(conn: sqlite3.Connection, entity_id: str) -> dict[str, Any] | None:
    """Get a canonical entity by ID."""
    row = conn.execute("SELECT * FROM canonical_entities WHERE id=?", (entity_id,)).fetchone()
    if not row:
        return None
    result = dict(row)
    result["data"] = json.loads(result.pop("data_json"))
    return result


def find_entity_by_source(
    conn: sqlite3.Connection,
    *,
    source_system: str,
    source_type: str,
    source_id: str,
) -> dict[str, Any] | None:
    """Find a canonical entity by its source mapping."""
    mapping = conn.execute(
        "SELECT entity_id FROM entity_mappings WHERE source_system=? AND source_type=? AND source_id=?",
        (source_system, source_type, source_id),
    ).fetchone()
    if not mapping:
        return None
    return get_canonical_entity(conn, mapping["entity_id"])


def add_source_mapping(
    conn: sqlite3.Connection,
    *,
    entity_id: str,
    source_system: str,
    source_type: str,
    source_id: str,
) -> str:
    """Add an additional source mapping to an existing canonical entity."""
    mapping_id = new_id("em")
    now = utc_now_iso()
    conn.execute(
        """INSERT OR IGNORE INTO entity_mappings (id, entity_id, source_system, source_type, source_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (mapping_id, entity_id, source_system, source_type, source_id, now),
    )
    conn.commit()
    return mapping_id


def soft_delete_entity(conn: sqlite3.Connection, entity_id: str) -> None:
    """Soft-delete a canonical entity."""
    now = utc_now_iso()
    conn.execute(
        "UPDATE canonical_entities SET is_deleted=1, deleted_at=?, updated_at=? WHERE id=?",
        (now, now, entity_id),
    )
    conn.commit()
