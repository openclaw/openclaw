"""Finalization gate: decides whether a card is eligible for stage promotion.

A card may only be auto-moved when ALL are true:
  1) Card is currently in "In Progress" list
  2) dueComplete == true (Trello completion checkbox)
  3) At least one delivery link (draft or final) exists

Then:
  - Draft link detected -> move to "Needs Review / Feedback"
  - Final link detected -> move to "Published / Delivered"

All Trello mutations respect DRY_RUN / SAFE_MODE.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.common.logging import get_logger, log_info
from packages.domain.card_state import get_card_state, upsert_card_state
from packages.domain.delivery_links import set_truth_badge
from packages.domain.trello_lists import CanonicalClientLists, resolve_list_id_by_name
from packages.integrations.trello.client import TrelloClient

logger = get_logger("finalization_gate")

_LISTS = CanonicalClientLists()


def _resolve_list_name(board_id: str, list_id: str) -> str:
    """Get list name from Trello API."""
    if settings.DRY_RUN or settings.SAFE_MODE:
        return ""
    try:
        tc = TrelloClient()
        lists = tc.get_lists(board_id=board_id)
        for lst in lists:
            if lst.get("id") == list_id:
                return str(lst.get("name") or "")
    except Exception:
        pass
    return ""


def _read_delivery_block(desc: str) -> dict[str, Any]:
    """Parse delivery links JSON from card description."""
    begin = settings.MARKER_BEGIN_DELIVERY_LINKS
    end = settings.MARKER_END_DELIVERY_LINKS
    if begin not in desc or end not in desc:
        return {}
    mid = desc.split(begin, 1)[1]
    body = mid.split(end, 1)[0].strip()
    if not body:
        return {}
    try:
        return json.loads(body)
    except Exception:
        return {}


def _has_entries(entries: Any) -> bool:
    """Check if a draft/final list has at least one entry (object or string)."""
    if not isinstance(entries, list):
        return False
    return len(entries) > 0


def evaluate_finalization(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    board_id: str,
    has_new_drafts: bool = False,
    has_new_finals: bool = False,
    delivery_event_id: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Evaluate whether card passes the finalization gate and auto-move if eligible.

    Event-gated: when delivery_event_id is provided, auto-moves are triggered only
    based on the current event's extracted links (has_new_drafts/has_new_finals),
    not on historical final links sitting in the delivery block.

    Returns:
      {
        "eligible": bool,
        "reason": str,
        "has_drafts": bool,
        "has_finals": bool,
        "due_complete": bool,
        "in_progress": bool,
        "moved_to": str | None,
        "truth_badge": str,
        "delivery_event_id": str | None,
      }
    """
    state = get_card_state(conn, card_id)
    due_complete = bool(state and state.get("due_complete"))
    list_id = (state.get("trello_list_id") or "") if state else ""

    # Determine current list name
    list_name = ""
    if list_id and board_id:
        list_name = _resolve_list_name(board_id, list_id)

    in_progress = list_name == _LISTS.in_progress

    # Read delivery block from card description
    delivery: dict[str, Any] = {}
    if not (settings.DRY_RUN or settings.SAFE_MODE):
        try:
            tc = TrelloClient()
            card = tc.get_card(card_id=card_id)
            desc = card.get("desc") or ""
            delivery = _read_delivery_block(desc)
        except Exception:
            pass

    has_drafts = _has_entries(delivery.get("draft"))
    has_finals = _has_entries(delivery.get("final"))

    # Event-gated: when delivery_event_id is provided, use the current event's
    # links for move decisions, not historical delivery block contents.
    # This prevents old finals from accidentally re-triggering moves.
    if delivery_event_id:
        event_has_links = has_new_drafts or has_new_finals
    else:
        event_has_links = has_drafts or has_finals

    eligible = in_progress and due_complete and event_has_links
    moved_to: str | None = None

    if not in_progress:
        reason = "card_not_in_progress"
    elif not due_complete:
        reason = "due_not_complete"
    elif not event_has_links:
        reason = "no_delivery_links_in_event"
    else:
        reason = "eligible"

    # Compute truth_badge
    badge = _compute_badge(list_name, due_complete, has_drafts, has_finals, delivery)

    # Auto-move if gate passes (event-gated: only current event's links decide target)
    # Gated by feature flags: AUTO_MOVE_FINAL_TO_PUBLISHED, AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW
    if eligible:
        if has_new_finals and settings.AUTO_MOVE_FINAL_TO_PUBLISHED:
            target_list = _LISTS.published
            badge = "published"
        elif has_new_drafts and settings.AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW:
            target_list = _LISTS.needs_review
            badge = "ready_for_review"
        elif has_finals and not delivery_event_id and settings.AUTO_MOVE_FINAL_TO_PUBLISHED:
            # Non-event-gated fallback (e.g. dueComplete toggle): use historical
            target_list = _LISTS.published
            badge = "published"
        elif has_drafts and not delivery_event_id and settings.AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW:
            target_list = _LISTS.needs_review
            badge = "ready_for_review"
        else:
            target_list = None

        if target_list:
            moved_to = _try_move_card(conn, card_id=card_id, board_id=board_id, target_list=target_list, correlation_id=correlation_id)

    # Update truth_badge in delivery block (force: gate is authoritative)
    set_truth_badge(conn, card_id=card_id, badge=badge, force=True, correlation_id=correlation_id)

    log_info(logger, "finalization gate evaluated", extra={
        "card_id": card_id, "eligible": eligible, "reason": reason,
        "moved_to": moved_to, "truth_badge": badge,
        "delivery_event_id": delivery_event_id,
    })

    write_audit(
        conn,
        action="finalization_gate.evaluated",
        target=card_id,
        payload={
            "eligible": eligible,
            "reason": reason,
            "due_complete": due_complete,
            "in_progress": in_progress,
            "has_drafts": has_drafts,
            "has_finals": has_finals,
            "moved_to": moved_to,
            "truth_badge": badge,
            "delivery_event_id": delivery_event_id,
        },
        correlation_id=correlation_id,
    )

    return {
        "eligible": eligible,
        "reason": reason,
        "has_drafts": has_drafts,
        "has_finals": has_finals,
        "due_complete": due_complete,
        "in_progress": in_progress,
        "moved_to": moved_to,
        "truth_badge": badge,
        "delivery_event_id": delivery_event_id,
    }


def _compute_badge(
    list_name: str,
    due_complete: bool,
    has_drafts: bool,
    has_finals: bool,
    delivery: dict[str, Any],
) -> str:
    """Compute truth_badge from current state."""
    if list_name == _LISTS.requests:
        return "intake"
    if list_name == _LISTS.in_progress:
        if not due_complete:
            return "in_progress"
        if has_finals:
            return "published"
        if has_drafts:
            return "ready_for_review"
        return "needs_attention"
    if list_name == _LISTS.needs_review:
        return "ready_for_review"
    if list_name == _LISTS.approved_ready:
        rd = delivery.get("release_date")
        if rd:
            return "scheduled_publish"
        return "approved_ready"
    if list_name == _LISTS.published:
        return "published"
    return "in_progress"


def _try_move_card(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    board_id: str,
    target_list: str,
    correlation_id: str | None,
) -> str | None:
    """Move card to target list. Returns target list name if moved, None otherwise."""
    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"

    if mode == "dry_run":
        write_audit(
            conn,
            action="finalization_gate.move.simulated",
            target=card_id,
            payload={"target_list": target_list, "board_id": board_id},
            correlation_id=correlation_id,
        )
        return target_list

    try:
        tc = TrelloClient()
        lists = tc.get_lists(board_id=board_id)
        target_id = resolve_list_id_by_name(lists, target_list)
        if not target_id:
            write_audit(
                conn,
                action="finalization_gate.move.list_not_found",
                target=card_id,
                payload={"target_list": target_list, "board_id": board_id},
                correlation_id=correlation_id,
            )
            return None
        tc.move_card(card_id=card_id, list_id=target_id)
        write_audit(
            conn,
            action="finalization_gate.move.applied",
            target=card_id,
            payload={"target_list": target_list, "target_list_id": target_id},
            correlation_id=correlation_id,
        )
        return target_list
    except Exception:
        return None


def handle_revision_round_reset(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    board_id: str,
    from_list_name: str,
    to_list_name: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Reset dueComplete when a card moves Needs Review → In Progress (revision round).

    Only applies to the exact transition: "Needs Review / Feedback" → "In Progress".
    Sets truth_badge="in_progress" and dueComplete=false so the finalization gate
    remains consistent for the next delivery cycle.

    SAFE_MODE/DRY_RUN: no Trello mutation; audits would_set_due_complete_false.
    """
    if from_list_name != _LISTS.needs_review or to_list_name != _LISTS.in_progress:
        return {"ok": True, "skipped": True, "reason": "not_revision_round_transition"}

    if not settings.AUTO_TOGGLE_DUECOMPLETE_ON_REVISION:
        return {"ok": True, "skipped": True, "reason": "feature_disabled"}

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"

    # Update truth_badge (force: revision reset is authoritative)
    set_truth_badge(conn, card_id=card_id, badge="in_progress", force=True, correlation_id=correlation_id)

    # Update local DB state
    upsert_card_state(conn, card_id=card_id, due_complete=False)

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="revision_reset.would_set_due_complete_false",
            target=card_id,
            payload={"board_id": board_id, "from": from_list_name, "to": to_list_name},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": mode, "applied": False, "would_apply": True}

    tc = TrelloClient()
    card = tc.get_card(card_id=card_id)
    if card.get("dueComplete") is True:
        tc.update_card(card_id=card_id, due_complete=False)

    write_audit(
        conn,
        action="revision_reset.applied",
        target=card_id,
        payload={"board_id": board_id, "from": from_list_name, "to": to_list_name, "ts": now_ts()},
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": mode, "applied": True}


def maybe_apply_stage_move_after_delivery(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    delivery_kind: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Gate-compatible stage move for quick actions.

    Only auto-moves when:
      - Current list == In Progress
      - dueComplete == True
    Moves:
      DRAFT -> Needs Review / Feedback (if AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW)
      FINAL -> Published / Delivered (if AUTO_MOVE_FINAL_TO_PUBLISHED)

    SAFE_MODE/DRY_RUN: simulate only.
    """
    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="stage_move_after_delivery.simulated",
            target=card_id,
            payload={"delivery_kind": delivery_kind},
            correlation_id=correlation_id,
        )
        return {"ok": True, "moved": False, "reason": "dry_run"}

    tc = TrelloClient()
    card = tc.get_card(card_id=card_id)
    due_complete = bool(card.get("dueComplete"))
    board_id = card.get("idBoard", "")

    if not board_id:
        return {"ok": True, "moved": False, "reason": "no_board_id"}

    # Resolve current list name
    lists = tc.get_lists(board_id=board_id)
    id_to_name = {lst["id"]: lst["name"] for lst in lists}
    current_list_name = id_to_name.get(card.get("idList", ""), "")

    if current_list_name != _LISTS.in_progress:
        return {"ok": True, "moved": False, "reason": "not_in_progress", "current_list": current_list_name}

    if not due_complete:
        return {"ok": True, "moved": False, "reason": "due_not_complete"}

    name_to_id = {lst["name"]: lst["id"] for lst in lists}

    if delivery_kind == "DRAFT" and settings.AUTO_MOVE_DRAFT_TO_NEEDS_REVIEW:
        target_list_id = name_to_id.get(_LISTS.needs_review)
        if target_list_id:
            tc.move_card(card_id=card_id, list_id=target_list_id)
            write_audit(
                conn,
                action="stage_move_after_delivery.applied",
                target=card_id,
                payload={"to": _LISTS.needs_review, "kind": delivery_kind},
                correlation_id=correlation_id,
            )
            return {"ok": True, "moved": True, "to": _LISTS.needs_review}

    if delivery_kind == "FINAL" and settings.AUTO_MOVE_FINAL_TO_PUBLISHED:
        target_list_id = name_to_id.get(_LISTS.published)
        if target_list_id:
            tc.move_card(card_id=card_id, list_id=target_list_id)
            write_audit(
                conn,
                action="stage_move_after_delivery.applied",
                target=card_id,
                payload={"to": _LISTS.published, "kind": delivery_kind},
                correlation_id=correlation_id,
            )
            return {"ok": True, "moved": True, "to": _LISTS.published}

    return {"ok": True, "moved": False, "reason": "flag_disabled_or_unknown_kind"}
