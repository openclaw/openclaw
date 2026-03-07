from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.trello_cards import upsert_card_top
from packages.domain.trello_lists import CanonicalClientLists, ensure_client_board_schema
from packages.integrations.trello.client import TrelloClient


def apply_start_here_and_welcome(
    conn: sqlite3.Connection,
    *,
    board_id: str,
    lifecycle_card_id: str,
    client_name: str,
    ghl_contact_id: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Create a top-positioned START HERE card and add a welcome comment to Lifecycle card."""
    tc = TrelloClient()
    mapping = ensure_client_board_schema(board_id, tc)
    ref_list_id = mapping[CanonicalClientLists().reference]

    start_here_name = settings.TRELLO_REFERENCE_CARD_START_HERE_NAME or "START HERE"
    start_here_desc = (
        "Start here\n\n"
        f"Client: {client_name}\n"
        "Workflow:\n"
        "1) Create requests in 'Requests'\n"
        "2) We move to 'In Progress' when active\n"
        "3) 'Needs Review / Feedback' means we need your notes\n"
        "4) 'Approved / Ready for Delivery' means approved and queued\n"
        "5) 'Published / Delivered' means done\n\n"
        "Where to put links:\n"
        "- Use cards in 'Reference & Links' (Dropbox, brand kit, dates)\n\n"
        "JSON:\n"
        + json.dumps(
            {"type": "start_here", "ghl_contact_id": ghl_contact_id},
            separators=(",", ":"),
        )
    )

    start_here_card_id = upsert_card_top(
        conn,
        board_id=board_id,
        list_id=ref_list_id,
        card_name=start_here_name,
        desc=start_here_desc,
        correlation_id=correlation_id,
    )

    welcome_comment = (
        "Welcome.\n\n"
        f"Client: {client_name}\n"
        "Instructions:\n"
        "- Review the 'START HERE' card in Reference & Links.\n"
        "- Add requests in 'Requests'.\n"
        "- Provide ratio/platform/deadline and references when possible.\n\n"
        "JSON:\n"
        + json.dumps(
            {
                "event": "welcome",
                "start_here_card_id": start_here_card_id,
                "ghl_contact_id": ghl_contact_id,
                "correlation_id": correlation_id,
            },
            separators=(",", ":"),
        )
    )

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="welcome.simulated",
            target=lifecycle_card_id,
            payload={"start_here_card_id": start_here_card_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "start_here_card_id": start_here_card_id}

    tc.add_comment(card_id=lifecycle_card_id, text=welcome_comment)
    write_audit(
        conn,
        action="welcome.applied",
        target=lifecycle_card_id,
        payload={"start_here_card_id": start_here_card_id},
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": "live", "start_here_card_id": start_here_card_id}
