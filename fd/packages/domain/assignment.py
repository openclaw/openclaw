from __future__ import annotations

import sqlite3
import time
import uuid
from typing import Any


def list_active_members(conn: sqlite3.Connection, role: str) -> list[dict[str, Any]]:
    cur = conn.execute(
        """
        SELECT member_id, display_name, role, capacity_points, skills_json
        FROM team_members
        WHERE is_active = 1 AND role = ?
        """,
        (role,),
    )
    return [dict(r) for r in cur.fetchall()]


def pick_member_round_robin(conn: sqlite3.Connection, role: str) -> dict[str, Any] | None:
    members = list_active_members(conn, role)
    if not members:
        return None
    # Naive: pick the member with the fewest recent assignments (last 7 days)
    week_ago = int(time.time()) - 7 * 24 * 3600
    counts = {m["member_id"]: 0 for m in members}
    cur = conn.execute(
        """
        SELECT member_id, COUNT(*) as c
        FROM assignments
        WHERE ts >= ? AND status IN ('assigned', 'reassigned')
        GROUP BY member_id
        """,
        (week_ago,),
    )
    for row in cur.fetchall():
        if row["member_id"] in counts:
            counts[row["member_id"]] = int(row["c"])
    members.sort(key=lambda m: counts.get(m["member_id"], 0))
    return members[0]


def create_assignment(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    card_id: str,
    member_id: str,
    reason: str,
    correlation_id: str | None,
    status: str = "assigned",
) -> str:
    assignment_id = f"asmt_{uuid.uuid4().hex}"
    conn.execute(
        """
        INSERT INTO assignments
        (assignment_id, ts, trello_board_id, card_id, member_id, reason, correlation_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            assignment_id,
            int(time.time()),
            trello_board_id,
            card_id,
            member_id,
            reason,
            correlation_id,
            status,
        ),
    )
    conn.commit()
    return assignment_id
