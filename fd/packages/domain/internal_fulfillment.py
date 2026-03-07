from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.request_routing import classify_request_type, route
from packages.domain.timeline import log_timeline_event
from packages.integrations.trello.client import TrelloClient


def _ensure_list_id(
    tc: TrelloClient, *, board_id: str, list_name: str, autocreate: bool
) -> str | None:
    lists = tc.get_lists(board_id=board_id)
    # 1. Exact match
    for lst in lists:
        if str(lst.get("name")) == list_name:
            return str(lst.get("id"))
    # 2. Case-insensitive match
    target = list_name.lower()
    for lst in lists:
        if str(lst.get("name")).lower() == target:
            return str(lst.get("id"))
    # 3. Auto-create if missing
    if autocreate:
        created = tc.create_list(board_id=board_id, name=list_name)
        return str(created.get("id"))
    return None


def _store_request(
    conn: sqlite3.Connection,
    *,
    request_id: str,
    source: str,
    source_event_id: str,
    ghl_contact_id: str | None,
    trello_board_id: str | None,
    client_card_id: str | None,
    internal_card_id: str | None,
    request_type: str,
    priority: str,
    status: str,
    payload: dict[str, Any],
    correlation_id: str | None,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO intake_requests
        (request_id, ts, source, source_event_id, ghl_contact_id, trello_board_id,
         client_card_id, internal_card_id, request_type, priority, status,
         payload_json, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            request_id,
            int(time.time()),
            source,
            source_event_id,
            ghl_contact_id,
            trello_board_id,
            client_card_id,
            internal_card_id,
            request_type,
            priority,
            status,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            correlation_id,
        ),
    )
    conn.commit()


def _store_work_order(
    conn: sqlite3.Connection,
    *,
    work_order_id: str,
    source: str,
    source_event_id: str,
    correlation_id: str | None,
    request_type: str,
    priority: str,
    status: str,
    client_board_id: str | None,
    client_card_id: str | None,
    internal_card_id: str | None,
    ghl_contact_id: str | None,
    payload: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO work_orders
        (work_order_id, ts, source, source_event_id, correlation_id,
         request_type, priority, status, client_board_id, client_card_id,
         internal_card_id, ghl_contact_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            work_order_id,
            int(time.time()),
            source,
            source_event_id,
            correlation_id,
            request_type,
            priority,
            status,
            client_board_id,
            client_card_id,
            internal_card_id,
            ghl_contact_id,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ),
    )
    conn.commit()


def create_work_order(
    conn: sqlite3.Connection,
    *,
    source: str,
    source_event_id: str,
    ghl_contact_id: str | None,
    client_board_id: str,
    client_card_id: str | None,
    intake_text: str,
    correlation_id: str | None,
    extra: dict[str, Any],
) -> dict[str, Any]:
    # Idempotency: if this client card was already mirrored, skip
    if client_card_id:
        cur = conn.execute(
            "SELECT request_id, internal_card_id FROM intake_requests WHERE source_event_id = ? AND source = ? LIMIT 1",
            (client_card_id, source),
        )
        existing = cur.fetchone()
        if existing:
            write_audit(
                conn,
                action="internal.work_order.skipped_duplicate",
                target="internal_fulfillment",
                payload={"client_card_id": client_card_id, "existing_request_id": existing["request_id"]},
                correlation_id=correlation_id,
            )
            return {
                "ok": True,
                "mode": "skipped_duplicate",
                "request_id": existing["request_id"],
                "internal_card_id": existing["internal_card_id"],
            }

    request_id = f"req_{uuid.uuid4().hex}"
    work_order_id = f"wo_{uuid.uuid4().hex}"
    req_type = classify_request_type(intake_text)
    role, priority = route(req_type)

    payload = {"text": intake_text, "extra": extra, "role": role, "priority": priority}

    # Persist early (both tables)
    _store_request(
        conn,
        request_id=request_id,
        source=source,
        source_event_id=source_event_id,
        ghl_contact_id=ghl_contact_id,
        trello_board_id=client_board_id,
        client_card_id=client_card_id,
        internal_card_id=None,
        request_type=req_type,
        priority=priority,
        status="new",
        payload=payload,
        correlation_id=correlation_id,
    )
    _store_work_order(
        conn,
        work_order_id=work_order_id,
        source=source,
        source_event_id=source_event_id,
        correlation_id=correlation_id,
        request_type=req_type,
        priority=priority,
        status="new",
        client_board_id=client_board_id,
        client_card_id=client_card_id,
        internal_card_id=None,
        ghl_contact_id=ghl_contact_id,
        payload=payload,
    )

    client_name = extra.get("client_name", "Client")
    card_title = extra.get("card_name", req_type.replace("_", " ").title())
    title = f"[{client_name}] — {card_title}"

    card_url = f"https://trello.com/c/{client_card_id}" if client_card_id else "N/A"
    desc = (
        f"CLIENT_BOARD_ID: {client_board_id}\n"
        f"CLIENT_CARD_ID: {client_card_id or 'N/A'}\n"
        f"CLIENT_CARD_URL: {card_url}\n"
        f"REQUEST_TYPE: {req_type}\n"
        f"PRIORITY: {priority}\n"
        f"ROLE: {role}\n"
        f"GHL_CONTACT_ID: {ghl_contact_id or 'N/A'}\n"
        f"CORRELATION_ID: {correlation_id or 'N/A'}\n\n"
        f"REQUEST_TEXT:\n{intake_text}\n"
    )

    if settings.DRY_RUN:
        write_audit(
            conn,
            action="internal.work_order.create(dry_run)",
            target="internal_fulfillment",
            payload={
                "request_id": request_id,
                "title": title,
                "client_board_id": client_board_id,
                "client_card_id": client_card_id,
            },
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "mode": "dry_run",
            "request_id": request_id,
            "work_order_id": work_order_id,
            "request_type": req_type,
            "role": role,
            "priority": priority,
        }

    if not settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID:
        return {"ok": False, "error": "missing_INTERNAL_FULFILLMENT_TRELLO_BOARD_ID"}

    tc = TrelloClient()

    inbox_list_id = _ensure_list_id(
        tc,
        board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID,
        list_name=settings.INTERNAL_FULFILLMENT_INBOX_LIST_NAME,
        autocreate=settings.INTERNAL_FULFILLMENT_AUTOCREATE_LISTS,
    )
    if not inbox_list_id:
        return {"ok": False, "error": "missing_internal_inbox_list"}

    created = tc.create_card(list_id=inbox_list_id, name=title, desc=desc)
    internal_card_id = str(created.get("id"))

    # Link back to client board/card for quick jump
    tc.add_attachment(
        card_id=internal_card_id,
        url_to_attach=f"https://trello.com/b/{client_board_id}",
        name="Client Board",
    )
    if client_card_id:
        tc.add_attachment(
            card_id=internal_card_id,
            url_to_attach=f"https://trello.com/c/{client_card_id}",
            name="Client Request Card",
        )

    _store_request(
        conn,
        request_id=request_id,
        source=source,
        source_event_id=source_event_id,
        ghl_contact_id=ghl_contact_id,
        trello_board_id=client_board_id,
        client_card_id=client_card_id,
        internal_card_id=internal_card_id,
        request_type=req_type,
        priority=priority,
        status="mirrored",
        payload=payload,
        correlation_id=correlation_id,
    )
    _store_work_order(
        conn,
        work_order_id=work_order_id,
        source=source,
        source_event_id=source_event_id,
        correlation_id=correlation_id,
        request_type=req_type,
        priority=priority,
        status="mirrored",
        client_board_id=client_board_id,
        client_card_id=client_card_id,
        internal_card_id=internal_card_id,
        ghl_contact_id=ghl_contact_id,
        payload=payload,
    )

    # Timeline log on CLIENT board primary card
    log_timeline_event(
        conn,
        trello_board_id=client_board_id,
        event_type="request_received",
        event_key=request_id,
        title="Request Received",
        human_fields={
            "Request ID": request_id,
            "Request Type": req_type,
            "Priority": priority,
            "Routed Role": role,
            "Internal Work Order Card": internal_card_id,
        },
        machine_fields={
            "request_id": request_id,
            "request_type": req_type,
            "priority": priority,
            "role": role,
            "internal_card_id": internal_card_id,
            "client_card_id": client_card_id,
        },
        correlation_id=correlation_id,
        primary_card_id=None,
    )

    return {
        "ok": True,
        "mode": "live",
        "request_id": request_id,
        "work_order_id": work_order_id,
        "internal_card_id": internal_card_id,
        "request_type": req_type,
        "role": role,
        "priority": priority,
    }
