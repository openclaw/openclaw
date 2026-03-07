"""Snapshot recorder — tracks backup file artifacts in the snapshots table.

Records file path, checksum, size, and status for each backup run.
Supports: SQLite DB snapshots, Trello metadata, Notion row exports.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.services.snapshots")


def sha256_file(path: str) -> str:
    """Compute SHA-256 checksum of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class SnapshotRecorder:
    """Records backup snapshots to the snapshots table.

    Usage::
        recorder = SnapshotRecorder(conn)
        recorder.record(
            snapshot_type="openclaw_db",
            storage_path="/backups/openclaw_db_2025-01-01.sqlite",
            status="ok",
            scope_key="./data/app.db",
        )
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def record(
        self,
        snapshot_type: str,
        storage_path: str,
        status: str,
        scope_key: str | None = None,
        details: str | None = None,
    ) -> str:
        """Record a snapshot entry. Returns the snapshot ID."""
        now = utc_now_iso()
        snap_id = new_id("snap")
        size_bytes = os.path.getsize(storage_path) if os.path.exists(storage_path) else None
        checksum = sha256_file(storage_path) if os.path.exists(storage_path) else None

        try:
            self.conn.execute(
                """INSERT INTO snapshots
                   (id, ts, snapshot_type, scope_key, storage_path,
                    checksum_sha256, size_bytes, status, details)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (snap_id, now, snapshot_type, scope_key, storage_path,
                 checksum, size_bytes, status, details),
            )
            self.conn.commit()
        except Exception as exc:
            log.error("snapshot_record_failed", extra={"error": str(exc)})
        return snap_id

    def get_recent(
        self, limit: int = 20, snapshot_type: str | None = None
    ) -> list[dict[str, Any]]:
        """Retrieve recent snapshots with optional type filter."""
        if snapshot_type:
            rows = self.conn.execute(
                "SELECT * FROM snapshots WHERE snapshot_type=? ORDER BY ts DESC LIMIT ?",
                (snapshot_type, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM snapshots ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_latest(self, snapshot_type: str) -> dict[str, Any] | None:
        """Get the most recent snapshot of a given type."""
        row = self.conn.execute(
            "SELECT * FROM snapshots WHERE snapshot_type=? ORDER BY ts DESC LIMIT 1",
            (snapshot_type,),
        ).fetchone()
        return dict(row) if row else None
