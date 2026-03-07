from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import yaml

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.views_registry")


def seed_views_registry(
    conn: sqlite3.Connection,
    manifest_path: str | Path | None = None,
) -> int:
    """Seed the views_registry table from template_manifest.yaml.

    Inserts all required_views from every database definition.
    Uses UPSERT to avoid duplicates.
    Returns count of rows upserted.
    """
    if manifest_path is None:
        manifest_path = Path(__file__).parent.parent / "notion" / "template_manifest.yaml"

    manifest = yaml.safe_load(Path(manifest_path).read_text())
    now = utc_now_iso()
    count = 0

    for db_key, db_spec in manifest.get("databases", {}).items():
        for view_name in db_spec.get("required_views", []):
            vid = new_id("vr")
            conn.execute(
                """INSERT INTO views_registry
                   (id, database_key, view_name, required, status, created_at, updated_at)
                   VALUES (?, ?, ?, 1, 'unknown', ?, ?)
                   ON CONFLICT(database_key, view_name) DO UPDATE SET
                     required=1,
                     updated_at=excluded.updated_at""",
                (vid, db_key, view_name, now, now),
            )
            count += 1

    conn.commit()
    log.info("views_registry_seeded", extra={"count": count})
    return count


def get_views_status(conn: sqlite3.Connection) -> dict[str, Any]:
    """Get views registry summary."""
    total = conn.execute("SELECT COUNT(*) FROM views_registry").fetchone()[0]
    required = conn.execute("SELECT COUNT(*) FROM views_registry WHERE required=1").fetchone()[0]
    ok_count = conn.execute("SELECT COUNT(*) FROM views_registry WHERE status='ok'").fetchone()[0]
    missing_count = conn.execute("SELECT COUNT(*) FROM views_registry WHERE status='missing'").fetchone()[0]
    unknown_count = conn.execute("SELECT COUNT(*) FROM views_registry WHERE status='unknown'").fetchone()[0]

    # Group by database
    db_rows = conn.execute(
        "SELECT database_key, COUNT(*) as total, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok_count "
        "FROM views_registry GROUP BY database_key ORDER BY database_key"
    ).fetchall()

    return {
        "total_views": total,
        "required_views": required,
        "ok": ok_count,
        "missing": missing_count,
        "unknown": unknown_count,
        "by_database": [
            {"database_key": r["database_key"], "total": r["total"], "ok": r["ok_count"]}
            for r in db_rows
        ],
    }


def mark_view_status(
    conn: sqlite3.Connection,
    *,
    database_key: str,
    view_name: str,
    status: str,
) -> None:
    """Update a view's verification status."""
    now = utc_now_iso()
    conn.execute(
        """UPDATE views_registry SET status=?, last_verified_at=?, updated_at=?
           WHERE database_key=? AND view_name=?""",
        (status, now, now, database_key, view_name),
    )
    conn.commit()
