from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.ghl_contact_index import get_index_by_board, get_index_by_contact
from packages.domain.trello_lists import CanonicalClientLists, ensure_client_board_schema
from packages.integrations.trello.client import TrelloClient

# Bidirectional mapping between Trello list names and GHL stages.
# Stage sync operates on the "Account / Lifecycle" card only, so real
# request cards are never moved by the system.

_CL = CanonicalClientLists()

TRELLO_TO_GHL: dict[str, str] = {
    _CL.requests: "Intake",
    _CL.in_progress: "In Production",
    _CL.needs_review: "Client Review",
    _CL.approved_ready: "Approved",
    _CL.published: "Delivered",
}

GHL_TO_TRELLO: dict[str, str] = {v: k for k, v in TRELLO_TO_GHL.items()}


def _should_suppress(
    conn: sqlite3.Connection,
    *,
    entity_key: str,
    incoming_source: str,
    incoming_value: str,
) -> bool:
    """Suppress echo: if the opposite source just wrote the same value recently."""
    row = conn.execute(
        "SELECT * FROM stage_sync_state WHERE entity_key=?",
        (entity_key,),
    ).fetchone()
    if not row:
        return False
    last_source = row["last_source"]
    last_ts = int(row["last_ts"])
    last_value = row["last_value"]
    if (
        last_source != incoming_source
        and (now_ts() - last_ts) <= settings.STAGE_SYNC_ECHO_SUPPRESS_SECONDS
        and last_value == incoming_value
    ):
        return True
    return False


def _set_state(
    conn: sqlite3.Connection,
    *,
    entity_key: str,
    source: str,
    value: str,
) -> None:
    conn.execute(
        """INSERT INTO stage_sync_state(entity_key, last_source, last_ts, last_value)
           VALUES (?,?,?,?)
           ON CONFLICT(entity_key) DO UPDATE SET
             last_source=excluded.last_source,
             last_ts=excluded.last_ts,
             last_value=excluded.last_value
        """,
        (entity_key, source, now_ts(), value),
    )
    conn.commit()


def trello_lifecycle_move_to_ghl_stage(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    new_list_name: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Trello lifecycle card moved → sync stage to GHL."""
    ghl_stage = TRELLO_TO_GHL.get(new_list_name)
    if not ghl_stage:
        return {"ok": True, "skipped": True, "reason": "unmapped_list"}

    idx = get_index_by_board(conn, trello_board_id=trello_board_id)
    if not idx or not idx.get("ghl_contact_id"):
        return {"ok": False, "error": "missing_contact_mapping"}

    entity_key = f"board:{trello_board_id}:lifecycle"
    if _should_suppress(conn, entity_key=entity_key, incoming_source="trello", incoming_value=ghl_stage):
        write_audit(
            conn,
            action="stage_sync.suppressed",
            target=entity_key,
            payload={"source": "trello", "stage": ghl_stage},
            correlation_id=correlation_id,
        )
        return {"ok": True, "suppressed": True}

    # v1: log + audit. Wire GHL opportunity update once opportunity_id is available.
    write_audit(
        conn,
        action="stage_sync.trello_to_ghl",
        target=idx["ghl_contact_id"],
        payload={"stage": ghl_stage, "board_id": trello_board_id},
        correlation_id=correlation_id,
    )
    _set_state(conn, entity_key=entity_key, source="trello", value=ghl_stage)
    return {
        "ok": True,
        "direction": "trello_to_ghl",
        "stage": ghl_stage,
        "ghl_contact_id": idx["ghl_contact_id"],
    }


def ghl_stage_to_trello_lifecycle_move(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str,
    ghl_stage: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """GHL stage changed → move Trello lifecycle card to matching list."""
    trello_list_name = GHL_TO_TRELLO.get(ghl_stage)
    if not trello_list_name:
        return {"ok": True, "skipped": True, "reason": "unmapped_stage"}

    idx = get_index_by_contact(conn, ghl_contact_id=ghl_contact_id)
    if not idx or not idx.get("trello_board_id"):
        return {"ok": False, "error": "missing_board_mapping"}

    board_id = idx["trello_board_id"]
    entity_key = f"board:{board_id}:lifecycle"
    if _should_suppress(conn, entity_key=entity_key, incoming_source="ghl", incoming_value=ghl_stage):
        write_audit(
            conn,
            action="stage_sync.suppressed",
            target=entity_key,
            payload={"source": "ghl", "stage": ghl_stage},
            correlation_id=correlation_id,
        )
        return {"ok": True, "suppressed": True}

    # Resolve lifecycle card id
    link = conn.execute(
        "SELECT lifecycle_card_id FROM trello_board_links WHERE trello_board_id=?",
        (board_id,),
    ).fetchone()
    if not link or not link["lifecycle_card_id"]:
        return {"ok": False, "error": "missing_lifecycle_card_id"}

    lifecycle_card_id = link["lifecycle_card_id"]

    tc = TrelloClient()
    mapping = ensure_client_board_schema(board_id, tc)
    target_list_id = mapping.get(trello_list_name)

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="stage_sync.ghl_to_trello.simulated",
            target=lifecycle_card_id,
            payload={"to": trello_list_name},
            correlation_id=correlation_id,
        )
        _set_state(conn, entity_key=entity_key, source="ghl", value=ghl_stage)
        return {"ok": True, "mode": "dry_run", "direction": "ghl_to_trello", "stage": ghl_stage}

    tc.move_card(card_id=lifecycle_card_id, list_id=target_list_id)
    write_audit(
        conn,
        action="stage_sync.ghl_to_trello",
        target=lifecycle_card_id,
        payload={"to": trello_list_name, "stage": ghl_stage},
        correlation_id=correlation_id,
    )
    _set_state(conn, entity_key=entity_key, source="ghl", value=ghl_stage)
    return {"ok": True, "mode": "live", "direction": "ghl_to_trello", "stage": ghl_stage}
