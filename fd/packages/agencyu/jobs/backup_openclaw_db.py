"""Backup job: OpenClaw SQLite database snapshot (daily).

Copies the SQLite database file and records to snapshots + audit tables.
"""
from __future__ import annotations

import os
import shutil
import sqlite3

from packages.agencyu.services.audit import AuditLogger
from packages.agencyu.services.snapshots import SnapshotRecorder
from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.backup_openclaw_db")


def utc_day() -> str:
    return utc_now_iso()[:10]


def backup_sqlite_db(
    conn: sqlite3.Connection,
    db_path: str,
    out_dir: str,
    correlation_id: str | None = None,
) -> str:
    """Snapshot the SQLite database.

    Args:
        conn: Active connection (for recording snapshot/audit).
        db_path: Path to the source SQLite file.
        out_dir: Directory to write the backup to.
        correlation_id: Optional correlation ID for audit trail.

    Returns:
        Path to the backup file.
    """
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, f"openclaw_db_{utc_day()}.sqlite")
    corr_id = correlation_id or new_id("corr")

    recorder = SnapshotRecorder(conn)
    audit = AuditLogger(conn)

    try:
        shutil.copy2(db_path, dst)
        recorder.record(
            snapshot_type="openclaw_db",
            storage_path=dst,
            status="ok",
            scope_key=db_path,
        )
        audit.log(
            correlation_id=corr_id,
            system="openclaw",
            action="backup",
            result="ok",
            target=f"file:{db_path}",
            payload={"backup_path": dst},
        )
        log.info("sqlite_backup_ok", extra={"path": dst})
    except Exception as exc:
        recorder.record(
            snapshot_type="openclaw_db",
            storage_path=dst,
            status="failed",
            scope_key=db_path,
            details=str(exc),
        )
        audit.log(
            correlation_id=corr_id,
            system="openclaw",
            action="backup",
            result="failed",
            target=f"file:{db_path}",
            stop_reason=str(exc),
        )
        log.error("sqlite_backup_failed", extra={"error": str(exc)})
        raise

    return dst
