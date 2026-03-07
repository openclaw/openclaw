"""Backup job: Trello board metadata export (daily).

Exports board/card metadata from local tables as JSON file.
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

log = get_logger("agencyu.jobs.backup_trello_metadata")

# Tables containing Trello-sourced data
TRELLO_TABLES = [
    "trello_board_links",
    "trello_card_state",
    "work_order_links",
    "work_order_mirror",
]


def utc_day() -> str:
    return utc_now_iso()[:10]


def backup_trello_boards(
    conn: sqlite3.Connection,
    out_dir: str,
    correlation_id: str | None = None,
) -> str:
    """Export Trello metadata from local tables as JSON.

    Args:
        conn: Active connection (for reading tables and recording snapshot).
        out_dir: Directory to write the backup to.
        correlation_id: Optional correlation ID for audit trail.

    Returns:
        Path to the backup file.
    """
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"trello_boards_{utc_day()}.json")
    corr_id = correlation_id or new_id("corr")

    recorder = SnapshotRecorder(conn)
    audit = AuditLogger(conn)

    try:
        payload: dict[str, Any] = {"exported_at": utc_now_iso(), "tables": {}}

        for table in TRELLO_TABLES:
            try:
                rows = conn.execute(f"SELECT * FROM {table}").fetchall()  # noqa: S608
                payload["tables"][table] = [dict(r) for r in rows]
            except Exception:
                payload["tables"][table] = []

        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, default=str)

        total_rows = sum(len(v) for v in payload["tables"].values())
        recorder.record(
            snapshot_type="trello_boards",
            storage_path=path,
            status="ok",
            scope_key="all_boards",
            details=f"{total_rows} rows from {len(TRELLO_TABLES)} tables",
        )
        audit.log(
            correlation_id=corr_id,
            system="trello",
            action="backup",
            result="ok",
            target="all_boards",
            payload={"total_rows": total_rows, "path": path},
        )
        log.info("trello_backup_ok", extra={"path": path, "rows": total_rows})
    except Exception as exc:
        recorder.record(
            snapshot_type="trello_boards",
            storage_path=path,
            status="failed",
            details=str(exc),
        )
        audit.log(
            correlation_id=corr_id,
            system="trello",
            action="backup",
            result="failed",
            stop_reason=str(exc),
        )
        log.error("trello_backup_failed", extra={"error": str(exc)})
        raise

    return path
