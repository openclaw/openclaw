"""Backup jobs for OpenClaw system data.

Provides:
- SQLite database file copy with checksum + retention
- Trello metadata JSON export
- Notion row snapshot (local cache)
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.backup_jobs")

DEFAULT_RETENTION_DAYS = 30
DEFAULT_BACKUP_DIR = "backups"


@dataclass
class BackupResult:
    """Result of a backup operation."""

    backup_id: str
    backup_type: str
    status: str  # success / error / skipped
    file_path: str | None = None
    checksum: str | None = None
    size_bytes: int | None = None
    details: str = ""
    error: str | None = None


def backup_sqlite(
    conn: sqlite3.Connection,
    backup_dir: str | Path | None = None,
    source_path: str | None = None,
) -> BackupResult:
    """Snapshot the SQLite database file.

    Uses shutil.copy2 for atomic file copy, then computes SHA-256 checksum.
    Records the backup run in backup_runs table.
    """
    backup_id = new_id("bk")
    now = utc_now_iso()

    if source_path is None:
        source_path = settings.SQLITE_PATH

    if backup_dir is None:
        backup_dir = Path(DEFAULT_BACKUP_DIR)
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = now.replace(":", "-").replace("T", "_").split(".")[0]
    dest_path = backup_dir / f"openclaw_db_{timestamp}.sqlite"

    try:
        shutil.copy2(source_path, dest_path)
        checksum = _sha256_file(dest_path)
        size_bytes = dest_path.stat().st_size

        result = BackupResult(
            backup_id=backup_id,
            backup_type="sqlite",
            status="success",
            file_path=str(dest_path),
            checksum=checksum,
            size_bytes=size_bytes,
            details=f"SQLite backup: {size_bytes} bytes, SHA-256: {checksum[:12]}...",
        )
    except Exception as exc:
        result = BackupResult(
            backup_id=backup_id,
            backup_type="sqlite",
            status="error",
            error=str(exc),
            details=f"SQLite backup failed: {exc}",
        )

    _record_backup_run(conn, result, now)
    log.info("backup_sqlite", extra={"status": result.status, "file": result.file_path})
    return result


def backup_trello_metadata(
    conn: sqlite3.Connection,
    backup_dir: str | Path | None = None,
) -> BackupResult:
    """Export Trello metadata from local tables as JSON.

    Exports: trello_board_links, trello_card_state, work_order_links, work_order_mirror.
    """
    backup_id = new_id("bk")
    now = utc_now_iso()

    if backup_dir is None:
        backup_dir = Path(DEFAULT_BACKUP_DIR)
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = now.replace(":", "-").replace("T", "_").split(".")[0]
    dest_path = backup_dir / f"trello_metadata_{timestamp}.json"

    tables = [
        "trello_board_links",
        "trello_card_state",
        "work_order_links",
        "work_order_mirror",
    ]

    try:
        export: dict[str, Any] = {"exported_at": now, "tables": {}}
        for table in tables:
            try:
                rows = conn.execute(f"SELECT * FROM {table}").fetchall()  # noqa: S608
                export["tables"][table] = [dict(r) for r in rows]
            except Exception:
                export["tables"][table] = []

        dest_path.write_text(json.dumps(export, indent=2, default=str))
        checksum = _sha256_file(dest_path)
        size_bytes = dest_path.stat().st_size

        total_rows = sum(len(v) for v in export["tables"].values())
        result = BackupResult(
            backup_id=backup_id,
            backup_type="trello_metadata",
            status="success",
            file_path=str(dest_path),
            checksum=checksum,
            size_bytes=size_bytes,
            details=f"Trello metadata: {total_rows} rows from {len(tables)} tables",
        )
    except Exception as exc:
        result = BackupResult(
            backup_id=backup_id,
            backup_type="trello_metadata",
            status="error",
            error=str(exc),
            details=f"Trello metadata backup failed: {exc}",
        )

    _record_backup_run(conn, result, now)
    log.info("backup_trello_metadata", extra={"status": result.status})
    return result


def backup_notion_snapshot(
    conn: sqlite3.Connection,
    backup_dir: str | Path | None = None,
) -> BackupResult:
    """Export Notion mirror state as JSON snapshot.

    Exports: notion_bindings, notion_mirrors, notion_mirror_state, canonical_entities.
    """
    backup_id = new_id("bk")
    now = utc_now_iso()

    if backup_dir is None:
        backup_dir = Path(DEFAULT_BACKUP_DIR)
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = now.replace(":", "-").replace("T", "_").split(".")[0]
    dest_path = backup_dir / f"notion_snapshot_{timestamp}.json"

    tables = [
        "notion_bindings",
        "notion_mirrors",
        "notion_mirror_state",
        "canonical_entities",
    ]

    try:
        export: dict[str, Any] = {"exported_at": now, "tables": {}}
        for table in tables:
            try:
                rows = conn.execute(f"SELECT * FROM {table}").fetchall()  # noqa: S608
                export["tables"][table] = [dict(r) for r in rows]
            except Exception:
                export["tables"][table] = []

        dest_path.write_text(json.dumps(export, indent=2, default=str))
        checksum = _sha256_file(dest_path)
        size_bytes = dest_path.stat().st_size

        total_rows = sum(len(v) for v in export["tables"].values())
        result = BackupResult(
            backup_id=backup_id,
            backup_type="notion_snapshot",
            status="success",
            file_path=str(dest_path),
            checksum=checksum,
            size_bytes=size_bytes,
            details=f"Notion snapshot: {total_rows} rows from {len(tables)} tables",
        )
    except Exception as exc:
        result = BackupResult(
            backup_id=backup_id,
            backup_type="notion_snapshot",
            status="error",
            error=str(exc),
            details=f"Notion snapshot backup failed: {exc}",
        )

    _record_backup_run(conn, result, now)
    log.info("backup_notion_snapshot", extra={"status": result.status})
    return result


def get_backup_history(
    conn: sqlite3.Connection,
    backup_type: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Get recent backup runs."""
    if backup_type:
        rows = conn.execute(
            "SELECT * FROM backup_runs WHERE backup_type=? ORDER BY started_at DESC LIMIT ?",
            (backup_type, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def cleanup_old_backups(
    backup_dir: str | Path | None = None,
    retention_days: int = DEFAULT_RETENTION_DAYS,
) -> int:
    """Remove backup files older than retention_days. Returns count of files removed."""
    import time

    if backup_dir is None:
        backup_dir = Path(DEFAULT_BACKUP_DIR)
    backup_dir = Path(backup_dir)

    if not backup_dir.exists():
        return 0

    cutoff = time.time() - (retention_days * 86400)
    removed = 0

    for f in backup_dir.iterdir():
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink()
            removed += 1

    log.info("backup_cleanup", extra={"removed": removed, "retention_days": retention_days})
    return removed


def _sha256_file(path: Path) -> str:
    """Compute SHA-256 checksum of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _record_backup_run(conn: sqlite3.Connection, result: BackupResult, now: str) -> None:
    """Record a backup run in the backup_runs table."""
    try:
        conn.execute(
            """INSERT INTO backup_runs
               (id, backup_type, status, file_path, checksum, size_bytes, details, started_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (result.backup_id, result.backup_type, result.status, result.file_path,
             result.checksum, result.size_bytes, result.details, now, now),
        )
        conn.commit()
    except Exception:
        pass
