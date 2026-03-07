from __future__ import annotations

import sqlite3
import time


def upsert_contact_board_map(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str,
    trello_board_id: str,
    primary_card_id: str | None,
    correlation_id: str | None,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO contact_board_map
        (ghl_contact_id, trello_board_id, primary_card_id, correlation_id, ts)
        VALUES (?, ?, ?, ?, ?)
        """,
        (ghl_contact_id, trello_board_id, primary_card_id, correlation_id, int(time.time())),
    )
    conn.commit()


def get_board_by_contact(conn: sqlite3.Connection, ghl_contact_id: str) -> tuple[str | None, str | None]:
    cur = conn.execute(
        """
        SELECT trello_board_id, primary_card_id
        FROM contact_board_map
        WHERE ghl_contact_id = ?
        """,
        (ghl_contact_id,),
    )
    row = cur.fetchone()
    if not row:
        return None, None
    return row["trello_board_id"], row["primary_card_id"]
