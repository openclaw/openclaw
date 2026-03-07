from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.aspect_ratio import detect_aspect_ratio_labels
from packages.domain.timeline import write_timeline
from packages.domain.trello_lists import ensure_internal_board_schema
from packages.domain.work_orders import attach_internal_card, create_or_get_work_order
from packages.integrations.trello.client import TrelloClient


def _is_request_list(list_name: str) -> bool:
    try:
        names = json.loads(settings.CLIENT_REQUEST_LIST_NAMES_JSON or "[]")
    except Exception:
        names = []
    return list_name in {str(x) for x in names}


def mirror_client_request(
    conn: sqlite3.Connection,
    *,
    client_board_id: str,
    client_board_name: str,
    client_card_id: str,
    client_card_url: str,
    client_list_name: str,
    card_name: str,
    card_desc: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Mirror a client request card to the internal fulfillment board.

    Idempotent: skips if the card has already been mirrored. Triggers
    auto-assignment after mirroring.
    """
    if not _is_request_list(client_list_name):
        return {"ok": True, "skipped": True, "reason": "not_request_list"}

    # Create work order idempotently based on client_card_id
    wo = create_or_get_work_order(
        conn,
        source="trello",
        source_event_id=client_card_id,
        correlation_id=correlation_id,
        request_type="unknown",
        priority="medium",
        client_board_id=client_board_id,
        client_card_id=client_card_id,
        ghl_contact_id=None,
        payload={
            "client_board_id": client_board_id,
            "client_board_name": client_board_name,
            "client_card_id": client_card_id,
            "client_card_url": client_card_url,
            "client_list_name": client_list_name,
            "card_name": card_name,
            "card_desc": card_desc,
        },
    )
    work_order_id = wo["work_order_id"]

    # If already mirrored, do not duplicate internal card
    row = conn.execute(
        "SELECT internal_card_id FROM work_orders WHERE work_order_id=?",
        (work_order_id,),
    ).fetchone()
    if row and row["internal_card_id"]:
        return {
            "ok": True,
            "created": False,
            "work_order_id": work_order_id,
            "internal_card_id": row["internal_card_id"],
        }

    # Ensure internal board schema
    tc = TrelloClient()
    internal_board_id = settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID
    internal_lists = ensure_internal_board_schema(internal_board_id, tc)
    inbox_list_id = (
        internal_lists.get(settings.INTERNAL_FULFILLMENT_INBOX_LIST_NAME)
        or internal_lists.get("Inbox")
    )

    aspect_labels = detect_aspect_ratio_labels((card_name or "") + "\n" + (card_desc or ""))

    internal_title = f"[MEDIUM] unknown — {client_board_name}"
    internal_desc = (
        f"Client Board: {client_board_name}\n"
        f"Client Board ID: {client_board_id}\n"
        f"Client Card ID: {client_card_id}\n"
        f"Client Card URL: {client_card_url}\n"
        f"Request List: {client_list_name}\n\n"
        f"Request Title: {card_name}\n\n"
        f"Request Text:\n{(card_desc or '').strip()}\n\n"
        f"Aspect Labels: {', '.join(aspect_labels) if aspect_labels else '(none)'}\n\n"
        f"Correlation ID: {correlation_id or '(none)'}\n"
        "JSON:\n"
        + json.dumps(
            {
                "event": "work_order_created",
                "work_order_id": work_order_id,
                "client_card_id": client_card_id,
                "correlation_id": correlation_id,
            },
            separators=(",", ":"),
        )
    )

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="trello.mirror.simulated",
            target=client_card_id,
            payload={"internal_title": internal_title},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "work_order_id": work_order_id, "internal_card_id": "dry_internal_card"}

    created = tc.create_card(list_id=inbox_list_id, name=internal_title, desc=internal_desc)
    internal_card_id = created["id"]
    attach_internal_card(
        conn,
        work_order_id=work_order_id,
        internal_card_id=internal_card_id,
        correlation_id=correlation_id,
    )

    # Comment back to client card
    tc.add_comment(
        card_id=client_card_id,
        text=(
            "Work order created.\n\n"
            f"Internal Card ID: {internal_card_id}\n\n"
            "JSON:\n"
            + json.dumps(
                {
                    "event": "work_order_created",
                    "internal_card_id": internal_card_id,
                    "correlation_id": correlation_id,
                },
                separators=(",", ":"),
            )
        ),
    )

    write_timeline(
        conn,
        trello_board_id=client_board_id,
        primary_card_id=client_card_id,
        event_type="work_order_created",
        title="Work order created",
        human={"internal_card_id": internal_card_id},
        machine={
            "event": "work_order_created",
            "work_order_id": work_order_id,
            "internal_card_id": internal_card_id,
        },
        correlation_id=correlation_id,
        event_key=f"work_order_created:{client_card_id}",
    )

    # Auto-assign (import here to avoid circular imports)
    from packages.domain.internal_assignment import assign_work_order as _assign

    _assign(conn, work_order_id=work_order_id, correlation_id=correlation_id)

    return {"ok": True, "mode": "live", "work_order_id": work_order_id, "internal_card_id": internal_card_id}
