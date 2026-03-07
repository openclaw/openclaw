from __future__ import annotations

import sqlite3

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.setter_os.touches")


def log_lead_touch(
    conn: sqlite3.Connection,
    *,
    lead_id: str,
    channel: str,
    action: str,
    outcome: str | None = None,
    note: str | None = None,
    correlation_id: str,
) -> str:
    """Log a setter touch on a lead (DM, SMS, email, call, etc.)."""
    now = utc_now_iso()
    tid = new_id("touch")
    conn.execute(
        """INSERT INTO lead_touch_log
           (id, lead_id, ts, channel, action, outcome, note, correlation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (tid, lead_id, now, channel, action, outcome, note, correlation_id, now),
    )
    conn.commit()
    return tid


def get_lead_touches(
    conn: sqlite3.Connection,
    *,
    lead_id: str,
    limit: int = 50,
) -> list[dict[str, str | None]]:
    """Get recent touches for a lead."""
    rows = conn.execute(
        "SELECT * FROM lead_touch_log WHERE lead_id=? ORDER BY ts DESC LIMIT ?",
        (lead_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]
