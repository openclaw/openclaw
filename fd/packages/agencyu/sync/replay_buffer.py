from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.replay_buffer")


def store_event(
    conn: sqlite3.Connection,
    *,
    source: str,
    event_type: str,
    payload: dict[str, Any],
    correlation_id: str = "",
) -> str:
    """Store a webhook event in the replay buffer."""
    event_id = new_id("evt")
    now = utc_now_iso()
    conn.execute(
        """INSERT INTO event_replay_buffer
           (id, source, event_type, payload_json, correlation_id, received_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (event_id, source, event_type, json.dumps(payload), correlation_id, now),
    )
    conn.commit()
    return event_id


def get_replayable_events(
    conn: sqlite3.Connection,
    *,
    source: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Get events that haven't been replayed yet."""
    if source:
        rows = conn.execute(
            """SELECT * FROM event_replay_buffer
               WHERE replayed=0 AND source=?
               ORDER BY received_at ASC LIMIT ?""",
            (source, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT * FROM event_replay_buffer
               WHERE replayed=0
               ORDER BY received_at ASC LIMIT ?""",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def mark_replayed(conn: sqlite3.Connection, event_id: str) -> None:
    """Mark an event as replayed."""
    now = utc_now_iso()
    conn.execute(
        "UPDATE event_replay_buffer SET replayed=1, replayed_at=? WHERE id=?",
        (now, event_id),
    )
    conn.commit()


def purge_old_events(conn: sqlite3.Connection, *, hours: int = 24) -> int:
    """Purge events older than N hours. Returns count deleted."""
    # SQLite datetime comparison
    cur = conn.execute(
        """DELETE FROM event_replay_buffer
           WHERE received_at < datetime('now', ? || ' hours')""",
        (f"-{hours}",),
    )
    conn.commit()
    return cur.rowcount


def get_buffer_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    """Get replay buffer statistics."""
    total = conn.execute("SELECT COUNT(*) FROM event_replay_buffer").fetchone()[0]
    pending = conn.execute("SELECT COUNT(*) FROM event_replay_buffer WHERE replayed=0").fetchone()[0]
    replayed = conn.execute("SELECT COUNT(*) FROM event_replay_buffer WHERE replayed=1").fetchone()[0]
    return {"total": total, "pending": pending, "replayed": replayed}
