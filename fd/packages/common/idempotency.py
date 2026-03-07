from __future__ import annotations

import sqlite3
import time


def seen_or_mark(conn: sqlite3.Connection, key: str) -> bool:
    """
    Returns True if key already seen. Otherwise marks it and returns False.
    """
    cur = conn.execute("SELECT key FROM idempotency WHERE key = ?", (key,))
    row = cur.fetchone()
    if row is not None:
        return True

    conn.execute("INSERT INTO idempotency (key, ts) VALUES (?, ?)", (key, int(time.time())))
    conn.commit()
    return False
