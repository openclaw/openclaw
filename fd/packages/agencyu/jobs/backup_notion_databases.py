"""Backup job: Notion database row snapshots (weekly or daily).

Exports Notion mirror state from local tables as JSON file.
Can also optionally query live Notion databases if API access is available.
"""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any

from packages.agencyu.services.audit import AuditLogger
from packages.agencyu.services.snapshots import SnapshotRecorder
from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.backup_notion_databases")

# Tables containing Notion mirror data
NOTION_TABLES = [
    "notion_bindings",
    "notion_mirrors",
    "notion_mirror_state",
    "canonical_entities",
]


def utc_day() -> str:
    return utc_now_iso()[:10]


def backup_notion_snapshot(
    conn: sqlite3.Connection,
    out_dir: str,
    correlation_id: str | None = None,
) -> str:
    """Export Notion mirror state from local tables as JSON.

    Args:
        conn: Active connection (for reading tables and recording snapshot).
        out_dir: Directory to write the backup to.
        correlation_id: Optional correlation ID for audit trail.

    Returns:
        Path to the backup file.
    """
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"notion_snapshot_{utc_day()}.json")
    corr_id = correlation_id or new_id("corr")

    recorder = SnapshotRecorder(conn)
    audit = AuditLogger(conn)

    try:
        payload: dict[str, Any] = {"exported_at": utc_now_iso(), "tables": {}}

        for table in NOTION_TABLES:
            try:
                rows = conn.execute(f"SELECT * FROM {table}").fetchall()  # noqa: S608
                payload["tables"][table] = [dict(r) for r in rows]
            except Exception:
                payload["tables"][table] = []

        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, default=str)

        total_rows = sum(len(v) for v in payload["tables"].values())
        recorder.record(
            snapshot_type="notion_db",
            storage_path=path,
            status="ok",
            scope_key="notion_mirror",
            details=f"{total_rows} rows from {len(NOTION_TABLES)} tables",
        )
        audit.log(
            correlation_id=corr_id,
            system="notion",
            action="backup",
            result="ok",
            target="notion_mirror",
            payload={"total_rows": total_rows, "path": path},
        )
        log.info("notion_backup_ok", extra={"path": path, "rows": total_rows})
    except Exception as exc:
        recorder.record(
            snapshot_type="notion_db",
            storage_path=path,
            status="failed",
            details=str(exc),
        )
        audit.log(
            correlation_id=corr_id,
            system="notion",
            action="backup",
            result="failed",
            stop_reason=str(exc),
        )
        log.error("notion_backup_failed", extra={"error": str(exc)})
        raise

    return path


def backup_live_notion_database(
    conn: sqlite3.Connection,
    notion_api: Any,
    database_id: str,
    out_dir: str,
    correlation_id: str | None = None,
) -> str:
    """Export a live Notion database by querying all rows via API.

    Args:
        conn: Active connection (for recording snapshot).
        notion_api: NotionAPI instance.
        database_id: Notion database ID to export.
        out_dir: Directory to write the backup to.
        correlation_id: Optional correlation ID for audit trail.

    Returns:
        Path to the backup file.
    """
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"notion_db_{database_id}_{utc_day()}.json")
    corr_id = correlation_id or new_id("corr")

    recorder = SnapshotRecorder(conn)
    audit = AuditLogger(conn)

    try:
        rows = notion_api.query_all_database_rows(database_id)
        payload: dict[str, Any] = {
            "exported_at": utc_now_iso(),
            "database_id": database_id,
            "row_count": len(rows),
            "rows": rows,
        }

        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, default=str)

        recorder.record(
            snapshot_type="notion_db",
            storage_path=path,
            status="ok",
            scope_key=database_id,
            details=f"{len(rows)} rows",
        )
        audit.log(
            correlation_id=corr_id,
            system="notion",
            action="backup",
            result="ok",
            target=f"db:{database_id}",
            payload={"row_count": len(rows), "path": path},
        )
        log.info("notion_live_backup_ok", extra={"db_id": database_id, "rows": len(rows)})
    except Exception as exc:
        recorder.record(
            snapshot_type="notion_db",
            storage_path=path,
            status="failed",
            scope_key=database_id,
            details=str(exc),
        )
        audit.log(
            correlation_id=corr_id,
            system="notion",
            action="backup",
            result="failed",
            target=f"db:{database_id}",
            stop_reason=str(exc),
        )
        log.error("notion_live_backup_failed", extra={"error": str(exc)})
        raise

    return path
