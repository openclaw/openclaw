from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.config import settings


def parse_stage_to_list() -> dict[str, str]:
    try:
        d = json.loads(settings.STAGE_TO_TRELLO_LIST_JSON or "{}")
        return {str(k): str(v) for k, v in d.items()}
    except Exception:
        return {}


def parse_list_to_stage() -> dict[str, str]:
    try:
        d = json.loads(settings.TRELLO_LIST_TO_STAGE_JSON or "{}")
        return {str(k): str(v) for k, v in d.items()}
    except Exception:
        return {}


def get_fulfillment_by_board(conn: sqlite3.Connection, board_id: str) -> dict[str, Any] | None:
    cur = conn.execute(
        """
        SELECT job_id, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json
        FROM fulfillment_jobs
        WHERE trello_board_id = ?
        ORDER BY ts DESC
        LIMIT 1
        """,
        (board_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    return dict(row)


def get_primary_card_and_lists(metadata_json: str) -> tuple[str | None, dict[str, str]]:
    try:
        meta = json.loads(metadata_json or "{}")
        primary_card_id = meta.get("primary_card_id")
        list_ids = meta.get("list_ids") or {}
        return (str(primary_card_id) if primary_card_id else None, {str(k): str(v) for k, v in list_ids.items()})
    except Exception:
        return (None, {})
