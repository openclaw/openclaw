"""Quick action buttons for internal team use.

Each action:
  1. Resolves client_card_id via work_order_links (accepts internal or client card id)
  2. Posts a professional Trello comment on the client card
  3. Merges delivery links into the canonical Delivery Links block (history + pointers)
  4. Applies gated stage move if eligible (In Progress + dueComplete)

SAFE_MODE / DRY_RUN: no Trello mutations; audits simulated actions.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.delivery_links import merge_delivery_links
from packages.domain.finalization_gate import maybe_apply_stage_move_after_delivery
from packages.domain.work_order_links import get_by_client_card_id, get_by_internal_card_id
from packages.integrations.trello.client import TrelloClient


def _resolve_pair(
    conn: sqlite3.Connection,
    *,
    internal_card_id: str | None,
    client_card_id: str | None,
) -> dict[str, Any]:
    """Resolve the work_order_links row from either card id."""
    if internal_card_id:
        link = get_by_internal_card_id(conn, internal_card_id)
        if not link:
            raise ValueError(f"No mapping for internal_card_id={internal_card_id}")
        return dict(link)
    if client_card_id:
        link = get_by_client_card_id(conn, client_card_id)
        if not link:
            raise ValueError(f"No mapping for client_card_id={client_card_id}")
        return dict(link)
    raise ValueError("internal_card_id or client_card_id required")


def post_draft_link(
    conn: sqlite3.Connection,
    *,
    internal_card_id: str | None = None,
    client_card_id: str | None = None,
    url: str,
    note: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Post a draft link to the client card + merge into Delivery Links."""
    link = _resolve_pair(conn, internal_card_id=internal_card_id, client_card_id=client_card_id)
    c_card = link["client_card_id"]

    comment = f"Draft link posted.\nURL: {url}"
    if note:
        comment += f"\nNote: {note}"

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(conn, action="quick_action.post_draft.simulated", target=c_card,
                    payload={"url": url, "note": note}, correlation_id=correlation_id)
        return {"ok": True, "mode": "dry_run", "client_card_id": c_card}

    tc = TrelloClient()
    tc.add_comment(card_id=c_card, text=comment)

    merge_delivery_links(
        conn,
        card_id=c_card,
        draft_urls=[url],
        final_urls=[],
        by="internal",
        note=note,
        source="quick_action.post_draft",
        suggested_truth_badge="in_progress",
        correlation_id=correlation_id,
    )

    move_res = maybe_apply_stage_move_after_delivery(
        conn, card_id=c_card, delivery_kind="DRAFT", correlation_id=correlation_id,
    )

    write_audit(conn, action="quick_action.post_draft.applied", target=c_card,
                payload={"url": url, "move": move_res}, correlation_id=correlation_id)
    return {"ok": True, "mode": "live", "client_card_id": c_card, "move": move_res}


def post_final_link(
    conn: sqlite3.Connection,
    *,
    internal_card_id: str | None = None,
    client_card_id: str | None = None,
    url: str,
    note: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Post a final deliverable link to the client card + merge into Delivery Links."""
    link = _resolve_pair(conn, internal_card_id=internal_card_id, client_card_id=client_card_id)
    c_card = link["client_card_id"]

    comment = f"Final deliverable posted.\nURL: {url}"
    if note:
        comment += f"\nNote: {note}"

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(conn, action="quick_action.post_final.simulated", target=c_card,
                    payload={"url": url, "note": note}, correlation_id=correlation_id)
        return {"ok": True, "mode": "dry_run", "client_card_id": c_card}

    tc = TrelloClient()
    tc.add_comment(card_id=c_card, text=comment)

    merge_delivery_links(
        conn,
        card_id=c_card,
        draft_urls=[],
        final_urls=[url],
        by="internal",
        note=note,
        source="quick_action.post_final",
        correlation_id=correlation_id,
    )

    move_res = maybe_apply_stage_move_after_delivery(
        conn, card_id=c_card, delivery_kind="FINAL", correlation_id=correlation_id,
    )

    write_audit(conn, action="quick_action.post_final.applied", target=c_card,
                payload={"url": url, "move": move_res}, correlation_id=correlation_id)
    return {"ok": True, "mode": "live", "client_card_id": c_card, "move": move_res}


def request_client_review(
    conn: sqlite3.Connection,
    *,
    internal_card_id: str | None = None,
    client_card_id: str | None = None,
    message: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Post a review request comment + optionally move to Needs Review / Feedback."""
    link = _resolve_pair(conn, internal_card_id=internal_card_id, client_card_id=client_card_id)
    c_card = link["client_card_id"]

    text = (message or "").strip() or (
        "Please review the latest draft and share feedback in this card. Thank you."
    )

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(conn, action="quick_action.request_review.simulated", target=c_card,
                    payload={"message": text}, correlation_id=correlation_id)
        return {"ok": True, "mode": "dry_run", "client_card_id": c_card}

    tc = TrelloClient()
    tc.add_comment(card_id=c_card, text=text)

    # If a draft exists and the gate flag is on, try to move to Needs Review
    move_res: dict[str, Any]
    if settings.AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW:
        move_res = maybe_apply_stage_move_after_delivery(
            conn, card_id=c_card, delivery_kind="DRAFT", correlation_id=correlation_id,
        )
    else:
        move_res = {"ok": True, "moved": False, "reason": "flag_disabled"}

    write_audit(conn, action="quick_action.request_review.applied", target=c_card,
                payload={"move": move_res}, correlation_id=correlation_id)
    return {"ok": True, "mode": "live", "client_card_id": c_card, "move": move_res}
