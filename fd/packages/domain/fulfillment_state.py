from __future__ import annotations

import sqlite3
import time


def mark_fulfillment_archived(conn: sqlite3.Connection, *, trello_board_id: str, reason: str) -> None:
    conn.execute(
        """
        UPDATE fulfillment_jobs
        SET status = ?, ts = ?
        WHERE trello_board_id = ?
        """,
        (f"archived:{reason}"[:100], int(time.time()), trello_board_id),
    )
    conn.commit()
