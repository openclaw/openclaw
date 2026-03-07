"""CRUD helpers for work_order_links table.

Maps client_card_id <-> internal_card_id for bidirectional sync between
client boards and the internal fulfillment board.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.clock import now_ts


def get_by_client_card_id(
    conn: sqlite3.Connection, client_card_id: str
) -> dict[str, Any] | None:
    """Look up a link by client card id."""
    row = conn.execute(
        "SELECT * FROM work_order_links WHERE client_card_id=? AND status='active'",
        (client_card_id,),
    ).fetchone()
    return dict(row) if row else None


def get_by_internal_card_id(
    conn: sqlite3.Connection, internal_card_id: str
) -> dict[str, Any] | None:
    """Look up a link by internal card id."""
    row = conn.execute(
        "SELECT * FROM work_order_links WHERE internal_card_id=? AND status='active'",
        (internal_card_id,),
    ).fetchone()
    return dict(row) if row else None


def upsert_link(
    conn: sqlite3.Connection,
    *,
    client_card_id: str,
    internal_card_id: str,
    client_board_id: str,
    internal_board_id: str,
) -> None:
    """Insert or update a work order link."""
    ts = str(now_ts())
    existing = conn.execute(
        "SELECT client_card_id FROM work_order_links WHERE client_card_id=?",
        (client_card_id,),
    ).fetchone()
    if existing:
        conn.execute(
            """UPDATE work_order_links
               SET internal_card_id=?, internal_board_id=?,
                   client_board_id=?, status='active', updated_ts=?
               WHERE client_card_id=?""",
            (internal_card_id, internal_board_id, client_board_id, ts, client_card_id),
        )
    else:
        conn.execute(
            """INSERT INTO work_order_links
               (client_card_id, client_board_id, internal_card_id, internal_board_id,
                status, created_ts, updated_ts)
               VALUES (?,?,?,?,?,?,?)""",
            (client_card_id, client_board_id, internal_card_id, internal_board_id,
             "active", ts, ts),
        )
    conn.commit()


def mark_inactive(conn: sqlite3.Connection, client_card_id: str) -> None:
    """Soft-delete a link by marking it inactive."""
    conn.execute(
        "UPDATE work_order_links SET status='inactive', updated_ts=? WHERE client_card_id=?",
        (str(now_ts()), client_card_id),
    )
    conn.commit()
