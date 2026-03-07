from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.capacity")


def upsert_team_capacity(
    conn: sqlite3.Connection,
    *,
    team_member_id: str,
    display_name: str,
    role: str | None = None,
    max_concurrent_work: int = 5,
    current_open_work: int = 0,
    enabled: bool = True,
) -> None:
    """Upsert team member capacity record."""
    now = utc_now_iso()
    conn.execute(
        """INSERT INTO team_capacity_v2
           (team_member_id, display_name, role, max_concurrent_work, current_open_work, enabled, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(team_member_id) DO UPDATE SET
             display_name=excluded.display_name,
             role=COALESCE(excluded.role, role),
             max_concurrent_work=excluded.max_concurrent_work,
             current_open_work=excluded.current_open_work,
             enabled=excluded.enabled,
             updated_at=excluded.updated_at""",
        (team_member_id, display_name, role, max_concurrent_work, current_open_work, int(enabled), now),
    )
    conn.commit()


def get_available_members(
    conn: sqlite3.Connection,
    *,
    role: str | None = None,
) -> list[dict[str, Any]]:
    """Get team members with available capacity, sorted by load (lightest first)."""
    if role:
        rows = conn.execute(
            """SELECT * FROM team_capacity_v2
               WHERE enabled=1 AND role=? AND current_open_work < max_concurrent_work
               ORDER BY current_open_work ASC""",
            (role,),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT * FROM team_capacity_v2
               WHERE enabled=1 AND current_open_work < max_concurrent_work
               ORDER BY current_open_work ASC"""
        ).fetchall()
    return [dict(r) for r in rows]


def increment_load(conn: sqlite3.Connection, team_member_id: str) -> None:
    """Increment current_open_work for a team member."""
    now = utc_now_iso()
    conn.execute(
        "UPDATE team_capacity_v2 SET current_open_work=current_open_work+1, updated_at=? WHERE team_member_id=?",
        (now, team_member_id),
    )
    conn.commit()


def decrement_load(conn: sqlite3.Connection, team_member_id: str) -> None:
    """Decrement current_open_work for a team member (floor at 0)."""
    now = utc_now_iso()
    conn.execute(
        """UPDATE team_capacity_v2
           SET current_open_work=MAX(0, current_open_work-1), updated_at=?
           WHERE team_member_id=?""",
        (now, team_member_id),
    )
    conn.commit()


def get_capacity_overview(conn: sqlite3.Connection) -> dict[str, Any]:
    """Get team capacity overview."""
    total = conn.execute("SELECT COUNT(*) FROM team_capacity_v2 WHERE enabled=1").fetchone()[0]
    available = conn.execute(
        "SELECT COUNT(*) FROM team_capacity_v2 WHERE enabled=1 AND current_open_work < max_concurrent_work"
    ).fetchone()[0]
    total_capacity = conn.execute(
        "SELECT COALESCE(SUM(max_concurrent_work), 0) FROM team_capacity_v2 WHERE enabled=1"
    ).fetchone()[0]
    total_load = conn.execute(
        "SELECT COALESCE(SUM(current_open_work), 0) FROM team_capacity_v2 WHERE enabled=1"
    ).fetchone()[0]
    utilization = round(total_load / total_capacity, 4) if total_capacity > 0 else 0.0

    return {
        "total_members": total,
        "available_members": available,
        "total_capacity": total_capacity,
        "total_load": total_load,
        "utilization": utilization,
    }
