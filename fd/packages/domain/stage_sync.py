from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.timeline import write_timeline

# Canonical mapping from Trello list names to GHL pipeline stages
TRELLO_TO_GHL_STAGE: dict[str, str] = {
    "Requests": "Intake",
    "In Progress": "In Production",
    "Needs Review / Feedback": "Client Review",
    "Approved / Ready for Delivery": "Approved",
    "Published / Delivered": "Delivered",
}


def trello_list_to_ghl_stage(list_name: str) -> str | None:
    """Look up the GHL stage for a given Trello list name."""
    return TRELLO_TO_GHL_STAGE.get(list_name)


def handle_trello_stage_change(
    conn: sqlite3.Connection,
    *,
    client_board_id: str,
    client_card_id: str,
    new_list_name: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Handle a Trello card move and sync the stage to GHL.

    In v1 this logs and audits; the actual GHL client call is a TODO
    to be wired in the next patch.
    """
    stage = trello_list_to_ghl_stage(new_list_name)
    if not stage:
        return {"ok": True, "skipped": True, "reason": "unmapped_list"}

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="stage_sync.trello_to_ghl.simulated",
            target=client_card_id,
            payload={"stage": stage},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "stage": stage}

    # TODO: call GHL client (update opportunity stage)
    write_audit(
        conn,
        action="stage_sync.trello_to_ghl.todo",
        target=client_card_id,
        payload={"stage": stage},
        correlation_id=correlation_id,
    )

    write_timeline(
        conn,
        trello_board_id=client_board_id,
        primary_card_id=client_card_id,
        event_type="stage_sync",
        title="Stage synced to GHL",
        human={"stage": stage, "source": "trello"},
        machine={"event": "stage_sync", "direction": "trello_to_ghl", "stage": stage},
        correlation_id=correlation_id,
        event_key=f"stage_sync:{client_card_id}:{stage}",
    )
    return {"ok": True, "mode": "live", "stage": stage}
