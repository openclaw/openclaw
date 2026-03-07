from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.setter_os.metrics")


def upsert_setter_daily_metrics(
    conn: sqlite3.Connection,
    *,
    date: str,
    setter_id: str,
    metrics: dict[str, Any],
) -> str:
    """Store or update EOD setter metrics for a given date.

    Mirrors the AgencyU documented EOD tracking concept.
    """
    now = utc_now_iso()
    row_id = new_id("sdm")
    conn.execute(
        """INSERT INTO setter_daily_metrics
           (id, date, setter_id, dms_sent, convos_started, followups_sent,
            booked_calls, notes_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(date, setter_id) DO UPDATE SET
             dms_sent=excluded.dms_sent,
             convos_started=excluded.convos_started,
             followups_sent=excluded.followups_sent,
             booked_calls=excluded.booked_calls,
             notes_json=excluded.notes_json,
             updated_at=excluded.updated_at""",
        (
            row_id,
            date,
            setter_id,
            int(metrics.get("dms_sent", 0)),
            int(metrics.get("convos_started", 0)),
            int(metrics.get("followups_sent", 0)),
            int(metrics.get("booked_calls", 0)),
            json.dumps(metrics.get("notes", {})),
            now,
            now,
        ),
    )
    conn.commit()
    return row_id


def get_setter_daily_metrics(
    conn: sqlite3.Connection,
    *,
    setter_id: str,
    date: str,
) -> dict[str, Any] | None:
    """Retrieve setter metrics for a specific date."""
    row = conn.execute(
        "SELECT * FROM setter_daily_metrics WHERE setter_id=? AND date=?",
        (setter_id, date),
    ).fetchone()
    return dict(row) if row else None
