"""Helpers for trello_card_state and scheduled_actions tables."""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import now_ts


def upsert_card_state(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    board_id: str | None = None,
    list_id: str | None = None,
    due_complete: bool | None = None,
    release_date_iso: str | None = None,
) -> None:
    """Insert or update a row in trello_card_state."""
    ts = str(now_ts())
    existing = conn.execute(
        "SELECT * FROM trello_card_state WHERE trello_card_id=?", (card_id,)
    ).fetchone()

    if existing is None:
        conn.execute(
            """INSERT INTO trello_card_state
               (trello_card_id, trello_board_id, trello_list_id,
                due_complete, release_date_iso, last_seen_ts, updated_ts)
               VALUES (?,?,?,?,?,?,?)""",
            (
                card_id,
                board_id,
                list_id,
                int(due_complete) if due_complete is not None else 0,
                release_date_iso,
                ts,
                ts,
            ),
        )
    else:
        sets: list[str] = ["last_seen_ts=?", "updated_ts=?"]
        vals: list[Any] = [ts, ts]
        if board_id is not None:
            sets.append("trello_board_id=?")
            vals.append(board_id)
        if list_id is not None:
            sets.append("trello_list_id=?")
            vals.append(list_id)
        if due_complete is not None:
            sets.append("due_complete=?")
            vals.append(int(due_complete))
        if release_date_iso is not None:
            sets.append("release_date_iso=?")
            vals.append(release_date_iso)
        vals.append(card_id)
        conn.execute(
            f"UPDATE trello_card_state SET {', '.join(sets)} WHERE trello_card_id=?",
            vals,
        )
    conn.commit()


def get_card_state(conn: sqlite3.Connection, card_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM trello_card_state WHERE trello_card_id=?", (card_id,)
    ).fetchone()
    return dict(row) if row else None


def insert_scheduled_action(
    conn: sqlite3.Connection,
    *,
    action_type: str,
    run_at_iso: str,
    payload: dict[str, Any],
) -> int:
    """Insert a scheduled action and return its id."""
    ts = str(now_ts())
    cur = conn.execute(
        """INSERT INTO scheduled_actions
           (action_type, run_at_iso, payload_json, status, created_ts, updated_ts)
           VALUES (?,?,?,?,?,?)""",
        (action_type, run_at_iso, json.dumps(payload), "pending", ts, ts),
    )
    conn.commit()
    return cur.lastrowid or 0


def get_pending_actions(
    conn: sqlite3.Connection,
    *,
    before_iso: str,
) -> list[dict[str, Any]]:
    """Return pending scheduled_actions where run_at_iso <= before_iso."""
    rows = conn.execute(
        "SELECT * FROM scheduled_actions WHERE status='pending' AND run_at_iso<=? ORDER BY run_at_iso",
        (before_iso,),
    ).fetchall()
    return [dict(r) for r in rows]


def mark_action_done(conn: sqlite3.Connection, action_id: int) -> None:
    conn.execute(
        "UPDATE scheduled_actions SET status='done', updated_ts=? WHERE id=?",
        (str(now_ts()), action_id),
    )
    conn.commit()


def mark_action_failed(conn: sqlite3.Connection, action_id: int) -> None:
    conn.execute(
        "UPDATE scheduled_actions SET status='failed', updated_ts=? WHERE id=?",
        (str(now_ts()), action_id),
    )
    conn.commit()
