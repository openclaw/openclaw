"""Sync stamp helpers for bidirectional stage sync loop prevention.

Keyed by pair_key = "{client_card_id}:{internal_card_id}".

Prevents:
- Infinite loops: same event_id → skip
- Out-of-order webhooks: older action_date → skip
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.clock import now_ts


def pair_key(client_card_id: str, internal_card_id: str) -> str:
    return f"{client_card_id}:{internal_card_id}"


def get_stamp(
    conn: sqlite3.Connection, *, client_card_id: str, internal_card_id: str
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM sync_stamps WHERE pair_key=?",
        (pair_key(client_card_id, internal_card_id),),
    ).fetchone()
    return dict(row) if row else None


def upsert_stamp(
    conn: sqlite3.Connection,
    *,
    client_card_id: str,
    internal_card_id: str,
    event_id: str,
    origin: str,
    action_date: str | None,
) -> None:
    k = pair_key(client_card_id, internal_card_id)
    conn.execute(
        """INSERT INTO sync_stamps(pair_key, last_event_id, last_origin, last_action_date, updated_ts)
           VALUES(?,?,?,?,?)
           ON CONFLICT(pair_key) DO UPDATE SET
             last_event_id=excluded.last_event_id,
             last_origin=excluded.last_origin,
             last_action_date=excluded.last_action_date,
             updated_ts=excluded.updated_ts
        """,
        (k, event_id, origin, action_date, str(now_ts())),
    )
    conn.commit()


def should_ignore_event(
    stamp: dict[str, Any] | None,
    *,
    event_id: str,
    action_date: str | None,
) -> bool:
    """Return True if this event should be skipped (loop or out-of-order)."""
    if not stamp:
        return False
    # Same event → loop
    if stamp.get("last_event_id") == event_id:
        return True
    # Out-of-order: action_date is ISO from Trello, string comparison works
    if (
        action_date
        and stamp.get("last_action_date")
        and action_date <= stamp["last_action_date"]
    ):
        return True
    return False
