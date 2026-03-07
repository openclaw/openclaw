from __future__ import annotations

import sqlite3


def resolve_client_board_id(conn: sqlite3.Connection, *, ghl_contact_id: str) -> str | None:
    """Resolve a GHL contact to their client Trello board ID.

    Resolution chain:
    1. contact_board_map (preferred, fast local index)
    2. fulfillment_jobs fallback (by ghl_contact_id, most recent)
    """
    # 1) Direct index table
    cur = conn.execute(
        "SELECT trello_board_id FROM contact_board_map WHERE ghl_contact_id = ? LIMIT 1",
        (ghl_contact_id,),
    )
    row = cur.fetchone()
    if row and row["trello_board_id"]:
        return str(row["trello_board_id"])

    # 2) Fallback: fulfillment_jobs
    cur = conn.execute(
        "SELECT trello_board_id FROM fulfillment_jobs WHERE ghl_contact_id = ? ORDER BY ts DESC LIMIT 1",
        (ghl_contact_id,),
    )
    row = cur.fetchone()
    if row and row["trello_board_id"]:
        return str(row["trello_board_id"])

    return None
