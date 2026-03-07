"""Bidirectional sync engine for 3-lane transitions between client and internal boards.

Synced lanes (identical names on both boards):
  - Requests
  - In Progress
  - Needs Review / Feedback

Loop prevention: DB-based sync_stamps keyed by pair_key (client:internal).
Out-of-order protection: action_date comparison (ISO string from Trello action.date).
Idempotent: checks current list before moving (no-op if already correct).

Assignment stays on internal cards only — client cards are never assigned.

SAFE_MODE / DRY_RUN: no Trello mutations; audits would_move.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.logging import get_logger, log_info
from packages.domain.delivery_links import set_truth_badge
from packages.domain.finalization_gate import handle_revision_round_reset
from packages.domain.sync_stamp import get_stamp, should_ignore_event, upsert_stamp
from packages.domain.trello_lists import CanonicalClientLists, resolve_list_id_by_name
from packages.domain.work_order_links import get_by_client_card_id, get_by_internal_card_id
from packages.integrations.trello.client import TrelloClient

logger = get_logger("stage_sync_internal_client")

_LISTS = CanonicalClientLists()

SYNC_LISTS = frozenset({_LISTS.requests, _LISTS.in_progress, _LISTS.needs_review})

# Map list name -> truth_badge value
_BADGE_MAP: dict[str, str] = {
    _LISTS.requests: "intake",
    _LISTS.in_progress: "in_progress",
    _LISTS.needs_review: "ready_for_review",
}


def _move_card_to_list(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    board_id: str,
    target_list_name: str,
    event_id: str,
    origin: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Move a card to a target list (idempotent: checks current list first)."""
    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"

    if mode == "dry_run":
        write_audit(
            conn,
            action="bidi_sync.move.simulated",
            target=card_id,
            payload={
                "board_id": board_id,
                "target_list": target_list_name,
                "event_id": event_id,
                "origin": origin,
            },
            correlation_id=correlation_id,
        )
        return {"moved": False, "would_move": True, "target": target_list_name}

    tc = TrelloClient()
    lists = tc.get_lists(board_id=board_id)
    target_id = resolve_list_id_by_name(lists, target_list_name)
    if not target_id:
        write_audit(
            conn,
            action="bidi_sync.move.list_not_found",
            target=card_id,
            payload={"board_id": board_id, "target_list": target_list_name},
            correlation_id=correlation_id,
        )
        return {"moved": False, "reason": "list_not_found"}

    # Idempotent: check current list
    card = tc.get_card(card_id=card_id)
    if card.get("idList", "") == target_id:
        return {"moved": False, "reason": "already_in_target_list"}

    tc.move_card(card_id=card_id, list_id=target_id)

    write_audit(
        conn,
        action="bidi_sync.move.applied",
        target=card_id,
        payload={
            "board_id": board_id,
            "target_list": target_list_name,
            "target_list_id": target_id,
            "event_id": event_id,
            "origin": origin,
        },
        correlation_id=correlation_id,
    )
    return {"moved": True, "target": target_list_name}


def sync_stage_three_lanes(
    conn: sqlite3.Connection,
    *,
    origin: str,
    moved_card_id: str,
    from_list_name: str,
    to_list_name: str,
    event_id: str,
    action_date: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Synchronize transitions across Requests / In Progress / Needs Review.

    Args:
        origin: "client" or "internal"
        moved_card_id: the card that was moved
        from_list_name: source list name
        to_list_name: destination list name
        event_id: Trello action id (used for dedup + stamp)
        action_date: ISO timestamp from Trello action.date (out-of-order guard)
        correlation_id: optional correlation id

    Returns:
        Result dict with sync outcome.
    """
    if from_list_name not in SYNC_LISTS or to_list_name not in SYNC_LISTS:
        return {"ok": True, "skipped": True, "reason": "not_synced_lane"}

    if from_list_name == to_list_name:
        return {"ok": True, "skipped": True, "reason": "same_list"}

    # Resolve mapping
    link: dict[str, Any] | None = None
    if origin == "client":
        link = get_by_client_card_id(conn, moved_card_id)
    elif origin == "internal":
        link = get_by_internal_card_id(conn, moved_card_id)
    else:
        return {"ok": True, "skipped": True, "reason": "unknown_origin"}

    if not link:
        log_info(logger, "no mapping for card", extra={
            "card_id": moved_card_id, "origin": origin,
        })
        return {"ok": True, "skipped": True, "reason": "no_mapping"}

    client_card_id = link["client_card_id"]
    internal_card_id = link["internal_card_id"]
    client_board_id = link["client_board_id"]
    internal_board_id = link["internal_board_id"]

    if not client_card_id or not internal_card_id:
        return {"ok": True, "skipped": True, "reason": "incomplete_mapping"}

    # Stamp-based loop prevention + out-of-order guard
    stamp = get_stamp(conn, client_card_id=client_card_id, internal_card_id=internal_card_id)
    if should_ignore_event(stamp, event_id=event_id, action_date=action_date):
        log_info(logger, "bidi sync stamp guard", extra={
            "card_id": moved_card_id, "event_id": event_id, "reason": "stamp_or_order",
        })
        return {"ok": True, "skipped": True, "reason": "stamp_or_order_guard"}

    # Determine counterpart
    if origin == "client":
        target_card_id = internal_card_id
        target_board_id = internal_board_id
    else:
        target_card_id = client_card_id
        target_board_id = client_board_id

    if not target_board_id:
        return {"ok": True, "skipped": True, "reason": "no_target_board"}

    log_info(logger, "bidi sync moving counterpart", extra={
        "origin": origin, "moved": moved_card_id,
        "counterpart": target_card_id, "to": to_list_name,
    })

    # Move counterpart card to matching list
    move_result = _move_card_to_list(
        conn,
        card_id=target_card_id,
        board_id=target_board_id,
        target_list_name=to_list_name,
        event_id=event_id,
        origin=origin,
        correlation_id=correlation_id,
    )

    # Write stamp AFTER move attempt (prevents loops even if duplicate webhook arrives)
    upsert_stamp(
        conn,
        client_card_id=client_card_id,
        internal_card_id=internal_card_id,
        event_id=event_id,
        origin=origin,
        action_date=action_date,
    )

    # Update truth_badge on BOTH cards (force: list position is authoritative)
    badge = _BADGE_MAP.get(to_list_name, "needs_attention")
    set_truth_badge(conn, card_id=client_card_id, badge=badge, force=True, correlation_id=correlation_id)
    set_truth_badge(conn, card_id=internal_card_id, badge=badge, force=True, correlation_id=correlation_id)

    # Revision round reset: Needs Review → In Progress resets dueComplete
    if (
        settings.AUTO_TOGGLE_DUECOMPLETE_ON_REVISION
        and from_list_name == _LISTS.needs_review
        and to_list_name == _LISTS.in_progress
    ):
        for cid, bid in [
            (moved_card_id, client_board_id if origin == "client" else internal_board_id),
            (target_card_id, target_board_id),
        ]:
            handle_revision_round_reset(
                conn,
                card_id=cid,
                board_id=bid,
                from_list_name=from_list_name,
                to_list_name=to_list_name,
                correlation_id=correlation_id,
            )

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    write_audit(
        conn,
        action="bidi_sync.completed",
        target=moved_card_id,
        payload={
            "mode": mode,
            "origin": origin,
            "from": from_list_name,
            "to": to_list_name,
            "counterpart": target_card_id,
            "event_id": event_id,
            "move_result": move_result,
        },
        correlation_id=correlation_id,
    )

    return {
        "ok": True,
        "mode": mode,
        "origin": origin,
        "counterpart_card_id": target_card_id,
        "event_id": event_id,
        "move_result": move_result,
    }
