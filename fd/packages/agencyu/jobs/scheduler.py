"""Scheduler helper — enqueue deferred actions into ``scheduled_actions``.

Used by the alternative scaling flow to queue "tomorrow remainder" jobs
that will trigger new approval requests when they run.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any


def enqueue_scheduled_action(
    conn: sqlite3.Connection,
    *,
    run_at_iso: str,
    action_type: str,
    brand: str,
    payload: dict[str, Any],
    correlation_id: str = "",
) -> int:
    """Insert a pending scheduled action.

    Stores *brand* and *correlation_id* inside ``payload_json`` since the
    ``scheduled_actions`` table schema doesn't have dedicated columns for them.

    Returns the row ID of the inserted action.
    """
    now = datetime.now(UTC).isoformat()
    enriched = {
        **payload,
        "brand": brand,
        "correlation_id": correlation_id,
    }
    cur = conn.execute(
        """INSERT INTO scheduled_actions
               (action_type, run_at_iso, payload_json, status, created_ts, updated_ts)
           VALUES (?, ?, ?, 'pending', ?, ?)""",
        [action_type, run_at_iso, json.dumps(enriched, ensure_ascii=False), now, now],
    )
    conn.commit()
    return cur.lastrowid or 0
