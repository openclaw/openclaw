"""Views Registry package — SQLite-backed contract tracking + Notion-side seeding/healing."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id


@dataclass
class ViewContract:
    """A required view contract that should exist in the Views Registry."""

    view_key: str
    database_key: str
    view_name: str


class ViewsRegistry:
    """SQLite-backed views registry for tracking required Notion views."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def ensure_contract(
        self, vc: ViewContract, *, safe_mode: bool = True,
    ) -> dict[str, Any]:
        """Ensure a view contract row exists in the local views_registry table."""
        row = self.conn.execute(
            "SELECT id FROM views_registry WHERE database_key = ? AND view_name = ?",
            (vc.database_key, vc.view_name),
        ).fetchone()

        if row:
            return {"action": "noop", "view_key": vc.view_key}

        if safe_mode:
            return {"action": "simulate_create", "view_key": vc.view_key}

        now = utc_now_iso()
        self.conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) "
            "VALUES (?, ?, ?, 1, 'ok', ?, ?)",
            (new_id("vr"), vc.database_key, vc.view_name, now, now),
        )
        self.conn.commit()
        return {"action": "created", "view_key": vc.view_key}

    def get_missing_views(self) -> list[dict[str, Any]]:
        """Return all views_registry rows with status='missing'."""
        rows = self.conn.execute(
            "SELECT database_key, view_name, status FROM views_registry WHERE status = 'missing'"
        ).fetchall()
        return [
            {"database_key": r[0], "view_name": r[1], "status": r[2]}
            for r in rows
        ]
