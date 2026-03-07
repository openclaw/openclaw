"""Internal mirror: create/update work order on internal board when card enters In Progress.

Trigger: client card moves Requests → In Progress.
- Creates or updates a mirrored work order card on internal fulfillment board
- Includes: client board id, card id, request title, truth_badge, assigned owner
- Does NOT require adding team members to client boards
- Keeps mapping in SQLite (client_card_id -> internal_work_order_card_id)

SAFE_MODE/DRY_RUN: simulate only.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.common.ids import new_id
from packages.domain.trello_lists import CanonicalClientLists
from packages.domain.work_order_links import upsert_link
from packages.integrations.trello.client import TrelloClient

_LISTS = CanonicalClientLists()


def _find_existing_mirror(conn: sqlite3.Connection, client_card_id: str) -> dict[str, Any] | None:
    """Look up existing mirror from work_orders table."""
    row = conn.execute(
        "SELECT work_order_id, internal_card_id, status FROM work_orders WHERE client_card_id=? ORDER BY ts DESC LIMIT 1",
        (client_card_id,),
    ).fetchone()
    return dict(row) if row else None


def mirror_to_internal_on_in_progress(
    conn: sqlite3.Connection,
    *,
    client_board_id: str,
    client_card_id: str,
    card_name: str,
    card_desc: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Create or update internal work order when card enters In Progress.

    Returns result dict with ok, mode, internal_card_id, work_order_id.
    """
    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"

    # Check if mirror already exists
    existing = _find_existing_mirror(conn, client_card_id)
    if existing and existing.get("internal_card_id"):
        # Already mirrored — update status
        conn.execute(
            "UPDATE work_orders SET status='in_progress' WHERE work_order_id=?",
            (existing["work_order_id"],),
        )
        conn.commit()
        write_audit(
            conn,
            action="internal_mirror.updated_to_in_progress",
            target=client_card_id,
            payload={"internal_card_id": existing["internal_card_id"], "mode": mode},
            correlation_id=correlation_id,
        )

        # Move internal card to In Progress list (if live)
        if mode == "live" and settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID:
            try:
                tc = TrelloClient()
                lists = tc.get_lists(board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID)
                for lst in lists:
                    if lst.get("name") == "In Progress":
                        tc.move_card(card_id=existing["internal_card_id"], list_id=lst["id"])
                        break
            except Exception:
                pass

        return {
            "ok": True,
            "mode": mode,
            "action": "updated",
            "internal_card_id": existing["internal_card_id"],
            "work_order_id": existing["work_order_id"],
        }

    # No existing mirror — create new work order
    work_order_id = new_id("wo")
    card_url = f"https://trello.com/c/{client_card_id}"
    title = f"[In Progress] — {card_name}"
    desc = (
        f"CLIENT_BOARD_ID: {client_board_id}\n"
        f"CLIENT_CARD_ID: {client_card_id}\n"
        f"CLIENT_CARD_URL: {card_url}\n"
        f"TRUTH_BADGE: in_progress\n"
        f"CORRELATION_ID: {correlation_id or 'N/A'}\n\n"
        f"REQUEST_TEXT:\n{card_desc or '(no description)'}\n"
    )

    internal_card_id: str | None = None

    if mode == "dry_run":
        internal_card_id = f"dry_internal_{client_card_id}"
        write_audit(
            conn,
            action="internal_mirror.create.simulated",
            target=client_card_id,
            payload={"title": title, "work_order_id": work_order_id},
            correlation_id=correlation_id,
        )
    elif settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID:
        tc = TrelloClient()
        # Find "In Progress" list on internal board
        lists = tc.get_lists(board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID)
        target_list_id: str | None = None
        for lst in lists:
            if lst.get("name") == "In Progress":
                target_list_id = lst["id"]
                break
        if not target_list_id:
            # Fallback to Inbox
            for lst in lists:
                if lst.get("name") == settings.INTERNAL_FULFILLMENT_INBOX_LIST_NAME:
                    target_list_id = lst["id"]
                    break

        if target_list_id:
            created = tc.create_card(list_id=target_list_id, name=title, desc=desc)
            internal_card_id = str(created.get("id"))
            # Link back to client card
            tc.add_attachment(
                card_id=internal_card_id,
                url_to_attach=card_url,
                name="Client Card",
            )
        write_audit(
            conn,
            action="internal_mirror.create.applied",
            target=client_card_id,
            payload={"internal_card_id": internal_card_id, "work_order_id": work_order_id},
            correlation_id=correlation_id,
        )

    # Store work order mapping
    ts = int(now_ts())
    conn.execute(
        """INSERT OR REPLACE INTO work_orders
           (work_order_id, ts, source, source_event_id, correlation_id,
            request_type, priority, status, client_board_id, client_card_id,
            internal_card_id, ghl_contact_id, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            work_order_id,
            ts,
            "trello",
            client_card_id,
            correlation_id,
            "general",
            "normal",
            "in_progress",
            client_board_id,
            client_card_id,
            internal_card_id,
            None,
            json.dumps({"card_name": card_name, "truth_badge": "in_progress"}),
        ),
    )
    conn.commit()

    # Maintain canonical work_order_links mapping for bidirectional sync
    if internal_card_id:
        upsert_link(
            conn,
            client_card_id=client_card_id,
            internal_card_id=internal_card_id,
            client_board_id=client_board_id,
            internal_board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID,
        )

    return {
        "ok": True,
        "mode": mode,
        "action": "created",
        "internal_card_id": internal_card_id,
        "work_order_id": work_order_id,
    }
