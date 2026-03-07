from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.internal_fulfillment import create_work_order
from packages.integrations.trello.client import TrelloClient


def _request_list_names() -> set[str]:
    try:
        names = json.loads(settings.CLIENT_REQUEST_LIST_NAMES_JSON or "[]")
    except Exception:
        names = []
    return set(str(x) for x in names) if isinstance(names, list) else set()


def should_mirror_request(list_name: str) -> bool:
    return list_name in _request_list_names()


def mirror_client_request_to_internal(
    conn: sqlite3.Connection,
    *,
    client_board_id: str,
    client_card_id: str,
    client_list_name: str,
    card_name: str,
    card_desc: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    if not should_mirror_request(client_list_name):
        return {"ok": True, "skipped": True, "reason": "not_request_list"}

    intake_text = (card_desc or "").strip()
    if not intake_text:
        intake_text = f"(No description) Card title: {card_name}"

    extra: dict[str, Any] = {"client_name": "Client", "source": "trello", "card_name": card_name}

    out = create_work_order(
        conn,
        source="trello",
        source_event_id=client_card_id,
        ghl_contact_id=None,
        client_board_id=client_board_id,
        client_card_id=client_card_id,
        intake_text=intake_text,
        correlation_id=correlation_id,
        extra=extra,
    )

    # Comment back on client card (only in live mode)
    if out.get("ok") and not settings.DRY_RUN and out.get("internal_card_id"):
        tc = TrelloClient()
        internal_id = out["internal_card_id"]
        corr = correlation_id or ""
        comment = (
            "Work order created.\n\n"
            f"Internal Card ID: {internal_id}\n\n"
            f"{settings.TIMELINE_JSON_MARKER}\n"
            f'{{"event":"work_order_created","internal_card_id":"{internal_id}","correlation_id":"{corr}"}}'
        )
        tc.add_comment_to_card(card_id=client_card_id, text=comment)

    write_audit(
        conn,
        action="trello.intake.mirror",
        target=client_card_id,
        payload={
            "client_board_id": client_board_id,
            "client_list_name": client_list_name,
            "result": out,
        },
        correlation_id=correlation_id,
    )
    return {"ok": True, "result": out}
