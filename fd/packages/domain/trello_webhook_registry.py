from __future__ import annotations

import sqlite3
import time
from typing import Any


def insert_webhook(
    conn: sqlite3.Connection,
    *,
    trello_webhook_id: str,
    trello_board_id: str,
    callback_url: str,
    correlation_id: str | None,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO trello_webhooks
        (trello_webhook_id, trello_board_id, callback_url, is_active, correlation_id, ts)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (trello_webhook_id, trello_board_id, callback_url, 1, correlation_id, int(time.time())),
    )
    conn.commit()


def deactivate_webhook(conn: sqlite3.Connection, trello_webhook_id: str) -> None:
    conn.execute(
        """
        UPDATE trello_webhooks
        SET is_active = 0
        WHERE trello_webhook_id = ?
        """,
        (trello_webhook_id,),
    )
    conn.commit()


def get_active_webhook_by_board(conn: sqlite3.Connection, trello_board_id: str) -> dict[str, Any] | None:
    cur = conn.execute(
        """
        SELECT trello_webhook_id, trello_board_id, callback_url, is_active, correlation_id, ts
        FROM trello_webhooks
        WHERE trello_board_id = ? AND is_active = 1
        ORDER BY ts DESC
        LIMIT 1
        """,
        (trello_board_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None
