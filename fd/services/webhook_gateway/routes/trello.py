from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Query, Request

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.cooldown import is_cooldown_active
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError, WebhookAuthError
from packages.common.idempotency import seen_or_mark
from packages.common.logging import get_logger, log_info
from packages.domain.card_enrichment import enrich_card_description_with_links
from packages.domain.card_state import insert_scheduled_action, upsert_card_state
from packages.domain.comment_link_enrichment import enrich_comment_links
from packages.domain.finalization_gate import evaluate_finalization, handle_revision_round_reset
from packages.domain.intake_normalizer import normalize_intake
from packages.domain.internal_mirror import mirror_to_internal_on_in_progress
from packages.domain.lifecycle_cleanup import cleanup_list_names, run_cleanup
from packages.domain.publish_receipt import stamp_publish_receipt
from packages.domain.release_date_parser import extract_release_date
from packages.domain.stage_sync_bidirectional import trello_lifecycle_move_to_ghl_stage
from packages.domain.stage_sync_internal_client import sync_stage_three_lanes
from packages.domain.sync import (
    get_fulfillment_by_board,
    get_primary_card_and_lists,
    parse_list_to_stage,
)
from packages.domain.timeline import log_timeline_event
from packages.domain.trello_aspect_ratio_labels import apply_aspect_ratio_labels
from packages.domain.trello_intake_mirror import mirror_client_request_to_internal
from packages.domain.work_order_links import get_by_client_card_id, get_by_internal_card_id
from packages.integrations.ghl.client import GHLClient
from packages.integrations.trello.client import TrelloClient

logger = get_logger("webhook.trello")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


def _require_secret(secret: str | None) -> None:
    if not settings.TRELLO_WEBHOOK_SECRET:
        raise WebhookAuthError("TRELLO_WEBHOOK_SECRET not configured")
    if secret != settings.TRELLO_WEBHOOK_SECRET:
        raise WebhookAuthError("Invalid Trello webhook secret")


@router.get("")
def trello_verify(secret: str | None = Query(default=None)) -> dict:
    # Trello does a verification call to the callback URL; return 200.
    _require_secret(secret)
    return {"ok": True}


@router.post("")
async def trello_webhook(request: Request, secret: str | None = Query(default=None)) -> dict:
    _require_secret(secret)

    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    payload: dict[str, Any] = await request.json()
    action = payload.get("action") if isinstance(payload, dict) else None
    model = payload.get("model") if isinstance(payload, dict) else None

    action_id = str(action.get("id")) if isinstance(action, dict) and action.get("id") else ""
    action_type = str(action.get("type")) if isinstance(action, dict) else ""
    action_date = str(action.get("date")) if isinstance(action, dict) and action.get("date") else None

    # Idempotency: Trello action id
    if action_id and seen_or_mark(_conn, key=f"trello:{action_id}"):
        return {"ok": True, "duplicate": True, "action_id": action_id}

    board_id = None
    if isinstance(model, dict):
        board_id = model.get("id")

    log_info(logger, "trello webhook received", extra={"action_id": action_id, "type": action_type, "board_id": board_id})

    # Cooldown gate: when circuit breaker is active, skip all Trello mutations.
    # We still ingest the event (idempotency + audit) but defer the heavy work.
    _cooldown = is_cooldown_active(_conn)
    if _cooldown:
        write_audit(
            _conn,
            action="trello.webhook.deferred_cooldown",
            target=action_id or "unknown",
            payload={
                "action_type": action_type,
                "board_id": board_id,
                "reason": "cooldown_active",
            },
        )
        # Enqueue a lightweight retry for list-move actions
        if action_type == "updateCard" and isinstance(action, dict):
            data = action.get("data") or {}
            list_after = (data.get("listAfter") or {}) if isinstance(data, dict) else {}
            if list_after.get("id"):
                card = (data.get("card") or {}) if isinstance(data, dict) else {}
                from datetime import UTC, datetime

                insert_scheduled_action(
                    _conn,
                    action_type="WEBHOOK_RETRY",
                    run_at_iso=(datetime.now(tz=UTC).isoformat()),
                    payload={
                        "original_action_id": action_id,
                        "action_type": action_type,
                        "card_id": str(card.get("id") or ""),
                        "board_id": str(board_id or ""),
                    },
                )
        return {"ok": True, "action_id": action_id, "deferred": True, "reason": "cooldown_active"}

    # If board is closed (updateBoard), trigger cleanup
    if action_type == "updateBoard":
        data = action.get("data") if isinstance(action, dict) else {}
        board_data = (data.get("board") or {}) if isinstance(data, dict) else {}
        closed = board_data.get("closed")
        board_id_from_action = str(board_data.get("id") or board_id or "")
        if closed is True and board_id_from_action:
            job = get_fulfillment_by_board(_conn, board_id_from_action)
            correlation_id = job.get("correlation_id") if job else None
            offer_key = job.get("offer_key") if job else None
            result = run_cleanup(
                _conn,
                source="trello",
                source_event_id=action_id or f"updateBoard:{board_id_from_action}",
                trello_board_id=board_id_from_action,
                correlation_id=correlation_id,
                reason="trello_board_closed",
                offer_key=str(offer_key) if offer_key else None,
            )
            return {"ok": True, "action_id": action_id, "sync": "cleanup_triggered", "cleanup": result}
        write_audit(
            _conn,
            action="trello.event.ignored",
            target="trello",
            payload={"action_id": action_id, "type": action_type},
        )
        return {"ok": True, "ignored": True, "action_id": action_id}

    # Handle card creation in a request list (intake mirror + AR labels)
    if action_type == "createCard":
        data = action.get("data") if isinstance(action, dict) else {}
        card = (data.get("card") or {}) if isinstance(data, dict) else {}
        card_id = str(card.get("id") or "")
        card_name = str(card.get("name") or "")
        lst = (data.get("list") or {}) if isinstance(data, dict) else {}
        list_name = str(lst.get("name") or "")
        card_board = (data.get("board") or {}) if isinstance(data, dict) else {}
        card_board_id = str(card_board.get("id") or board_id or "")

        # Don't mirror cards created on the internal fulfillment board itself
        if card_board_id == settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID:
            return {"ok": True, "ignored": True, "action_id": action_id, "reason": "internal_board"}

        write_audit(
            _conn,
            action="trello.card.created",
            target="trello",
            payload={"action_id": action_id, "card_id": card_id, "card_name": card_name, "list": list_name, "board_id": card_board_id},
        )

        # Fetch full card to get description (createCard webhook may not include desc)
        card_desc = ""
        if card_id and not settings.DRY_RUN:
            try:
                tc = TrelloClient()
                full_card = tc.get_card(card_id=card_id)
                card_desc = str(full_card.get("desc") or "")
            except Exception:
                pass

        mirror_result = mirror_client_request_to_internal(
            _conn,
            client_board_id=card_board_id,
            client_card_id=card_id,
            client_list_name=list_name,
            card_name=card_name,
            card_desc=card_desc,
            correlation_id=None,
        )

        ar_result = apply_aspect_ratio_labels(
            _conn,
            board_id=card_board_id,
            card_id=card_id,
            text=f"{card_name}\n{card_desc}",
            correlation_id=None,
        )

        # Intake normalizer: structured header for cards in Requests list
        intake_result = normalize_intake(
            _conn,
            card_id=card_id,
            card_name=card_name,
            card_desc=card_desc,
            list_name=list_name,
            correlation_id=None,
        )

        # Auto-enrich card description with extracted links
        enrich_result = None
        if card_id and card_desc:
            enrich_result = enrich_card_description_with_links(
                _conn, card_id=card_id, desc=card_desc, correlation_id=None,
            )

        # Parse release date from description + track card state
        release_date = extract_release_date(card_desc) if card_desc else None
        list_id = str(lst.get("id") or "")
        if card_id:
            upsert_card_state(
                _conn,
                card_id=card_id,
                board_id=card_board_id,
                list_id=list_id or None,
                release_date_iso=release_date,
            )

        # Store release_date in delivery block + schedule publish if in Approved list
        scheduled = None
        if release_date and card_id:
            from packages.domain.delivery_links import set_truth_badge

            approved_names = set(json.loads(settings.CLIENT_APPROVED_READY_LIST_NAMES_JSON))
            if list_name in approved_names:
                set_truth_badge(
                    _conn,
                    card_id=card_id,
                    badge="scheduled_publish",
                    release_date=release_date,
                    correlation_id=None,
                )
                if not (settings.DRY_RUN or settings.SAFE_MODE):
                    scheduled = insert_scheduled_action(
                        _conn,
                        action_type="MOVE_CARD",
                        run_at_iso=f"{release_date}T09:00:00",
                        payload={
                            "card_id": card_id,
                            "board_id": card_board_id,
                            "target_list_names": json.loads(settings.CLIENT_PUBLISHED_LIST_NAMES_JSON),
                            "reason": "release_date_publish",
                        },
                    )
            else:
                # Store release_date in delivery block without scheduling
                set_truth_badge(
                    _conn,
                    card_id=card_id,
                    badge="intake",
                    release_date=release_date,
                    correlation_id=None,
                )

        return {
            "ok": True, "action_id": action_id,
            "intake_mirror": mirror_result, "ar_labels": ar_result,
            "intake_normalizer": intake_result,
            "link_enrichment": enrich_result,
            "release_date": release_date, "scheduled_action_id": scheduled,
        }

    # Handle commentCard: extract links from comment, merge into delivery block
    if action_type == "commentCard":
        data = action.get("data") if isinstance(action, dict) else {}
        card = (data.get("card") or {}) if isinstance(data, dict) else {}
        card_id = str(card.get("id") or "")
        card_board = (data.get("board") or {}) if isinstance(data, dict) else {}
        card_board_id = str(card_board.get("id") or board_id or "")
        comment_text = str(data.get("text") or "")

        write_audit(
            _conn,
            action="trello.comment.received",
            target=card_id,
            payload={"action_id": action_id, "board_id": card_board_id},
        )

        # Extract links from comment, merge into delivery, evaluate gate
        enrich_result = None
        if card_id and comment_text:
            enrich_result = enrich_comment_links(
                _conn,
                card_id=card_id,
                comment_text=comment_text,
                board_id=card_board_id,
                correlation_id=None,
            )

        return {
            "ok": True, "action_id": action_id,
            "comment_enrichment": enrich_result,
        }

    # We care about updateCard for list moves AND dueComplete changes
    if action_type != "updateCard":
        write_audit(
            _conn,
            action="trello.event.ignored",
            target="trello",
            payload={"action_id": action_id, "type": action_type},
        )
        return {"ok": True, "ignored": True, "action_id": action_id}

    data = action.get("data") if isinstance(action, dict) else {}

    # Handle dueComplete toggle (updateCard with card.dueComplete change)
    card_data = (data.get("card") or {}) if isinstance(data, dict) else {}
    old_data = (data.get("old") or {}) if isinstance(data, dict) else {}
    if "dueComplete" in card_data and "dueComplete" in old_data:
        card_id = str(card_data.get("id") or "")
        due_complete = bool(card_data.get("dueComplete"))
        card_board_data = (data.get("board") or {}) if isinstance(data, dict) else {}
        card_board_id = str(card_board_data.get("id") or board_id or "")

        if card_id:
            upsert_card_state(
                _conn,
                card_id=card_id,
                board_id=card_board_id or None,
                due_complete=due_complete,
            )

        write_audit(
            _conn,
            action="trello.card.due_complete_changed",
            target=card_id,
            payload={"action_id": action_id, "due_complete": due_complete, "board_id": card_board_id},
        )

        # Re-evaluate finalization gate when completion toggled on
        gate_result = None
        if due_complete and card_id and card_board_id:
            gate_result = evaluate_finalization(
                _conn,
                card_id=card_id,
                board_id=card_board_id,
                correlation_id=None,
            )

        return {
            "ok": True, "action_id": action_id,
            "sync": "due_complete_updated",
            "due_complete": due_complete,
            "finalization_gate": gate_result,
        }

    # updateCard: list move (listBefore/listAfter)
    list_before = (data.get("listBefore") or {}) if isinstance(data, dict) else {}
    list_after = (data.get("listAfter") or {}) if isinstance(data, dict) else {}

    before_name = str(list_before.get("name") or "")
    after_name = str(list_after.get("name") or "")
    after_list_id = str(list_after.get("id") or "")
    card = (data.get("card") or {}) if isinstance(data, dict) else {}
    card_id = str(card.get("id") or "")
    card_name = str(card.get("name") or "")

    # Track list transitions in card state
    if card_id and after_list_id:
        upsert_card_state(
            _conn,
            card_id=card_id,
            board_id=str(board_id) if board_id else None,
            list_id=after_list_id,
        )

    write_audit(
        _conn,
        action="trello.card.moved",
        target="trello",
        payload={"action_id": action_id, "card_id": card_id, "card_name": card_name, "before": before_name, "after": after_name, "board_id": board_id},
    )

    # Revision round reset: Needs Review → In Progress resets dueComplete
    if before_name and after_name and card_id and board_id:
        handle_revision_round_reset(
            _conn,
            card_id=card_id,
            board_id=str(board_id),
            from_list_name=before_name,
            to_list_name=after_name,
            correlation_id=None,
        )

    # Publish receipt: stamp proof-of-work when card reaches Published / Delivered
    if after_name and card_id and board_id:
        stamp_publish_receipt(
            _conn,
            card_id=card_id,
            board_id=str(board_id),
            to_list_name=after_name,
            correlation_id=None,
        )

    # Internal mirror: when card moves into In Progress, create/update work order
    in_progress_names = set(json.loads(settings.CLIENT_IN_PROGRESS_LIST_NAMES_JSON))
    if after_name in in_progress_names and board_id and card_id:
        card_desc = ""
        if not settings.DRY_RUN:
            try:
                tc = TrelloClient()
                full_card = tc.get_card(card_id=card_id)
                card_desc = str(full_card.get("desc") or "")
            except Exception:
                pass
        mirror_to_internal_on_in_progress(
            _conn,
            client_board_id=str(board_id),
            client_card_id=card_id,
            card_name=card_name,
            card_desc=card_desc,
            correlation_id=None,
        )

    # Bidirectional sync: Requests / In Progress / Needs Review between client and internal boards
    if before_name and after_name and card_id and board_id:
        # Determine origin: client or internal
        bidi_origin: str | None = None
        if get_by_client_card_id(_conn, card_id):
            bidi_origin = "client"
        elif get_by_internal_card_id(_conn, card_id):
            bidi_origin = "internal"

        if bidi_origin:
            sync_stage_three_lanes(
                _conn,
                origin=bidi_origin,
                moved_card_id=card_id,
                from_list_name=before_name,
                to_list_name=after_name,
                event_id=action_id,
                action_date=action_date,
                correlation_id=None,
            )

    # Bidirectional stage sync: if the moved card is the lifecycle card, sync to GHL
    if board_id and after_name and card_id:
        link = _conn.execute(
            "SELECT lifecycle_card_id FROM trello_board_links WHERE trello_board_id=?",
            (str(board_id),),
        ).fetchone()
        if link and link["lifecycle_card_id"] == card_id:
            stage_res = trello_lifecycle_move_to_ghl_stage(
                _conn,
                trello_board_id=str(board_id),
                new_list_name=after_name,
                correlation_id=None,
            )
            return {"ok": True, "action_id": action_id, "sync": "lifecycle_stage_sync", "stage_sync": stage_res}

    # Card moved INTO a request list → intake mirror + AR labels
    if board_id and str(board_id) != settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID:
        card_desc = ""
        if card_id and not settings.DRY_RUN:
            try:
                tc = TrelloClient()
                full_card = tc.get_card(card_id=card_id)
                card_desc = str(full_card.get("desc") or "")
            except Exception:
                pass

        mirror_client_request_to_internal(
            _conn,
            client_board_id=str(board_id),
            client_card_id=card_id,
            client_list_name=after_name,
            card_name=card_name,
            card_desc=card_desc,
            correlation_id=None,
        )
        apply_aspect_ratio_labels(
            _conn,
            board_id=str(board_id),
            card_id=card_id,
            text=f"{card_name}\n{card_desc}",
            correlation_id=None,
        )
        # Auto-enrich card description with extracted links
        if card_id and card_desc:
            enrich_card_description_with_links(
                _conn, card_id=card_id, desc=card_desc, correlation_id=None,
            )

    if not board_id:
        return {"ok": True, "action_id": action_id, "sync": "skipped_missing_board_id"}

    # Find linked fulfillment job (board_id -> ghl_contact_id)
    job = get_fulfillment_by_board(_conn, str(board_id))
    if not job:
        write_audit(
            _conn,
            action="ghl.sync.skipped_no_fulfillment_job",
            target="gohighlevel",
            payload={"board_id": board_id, "after": after_name},
        )
        return {"ok": True, "action_id": action_id, "sync": "skipped_no_job"}

    ghl_contact_id = job.get("ghl_contact_id")
    correlation_id = job.get("correlation_id")

    # Lifecycle cleanup trigger: primary card moved into an archive list name
    archive_lists = set(cleanup_list_names())
    if after_name in archive_lists:
        meta_json = str(job.get("metadata_json") or "")
        primary_card_id, _ = get_primary_card_and_lists(meta_json)
        if primary_card_id and card_id == primary_card_id:
            offer_key = job.get("offer_key")
            result = run_cleanup(
                _conn,
                source="trello",
                source_event_id=action_id or f"cardMove:{card_id}",
                trello_board_id=str(board_id),
                correlation_id=correlation_id,
                reason=f"trello_primary_card_to:{after_name}",
                offer_key=str(offer_key) if offer_key else None,
            )
            return {"ok": True, "action_id": action_id, "sync": "cleanup_triggered", "cleanup": result}

    if not ghl_contact_id:
        write_audit(
            _conn,
            action="ghl.sync.skipped_missing_contact_id",
            target="gohighlevel",
            payload={"board_id": board_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "action_id": action_id, "sync": "skipped_missing_contact_id"}

    # Map Trello list name -> GHL stage id
    list_to_stage = parse_list_to_stage()
    stage_id = list_to_stage.get(after_name)

    if not stage_id:
        write_audit(
            _conn,
            action="ghl.sync.skipped_unmapped_list",
            target="gohighlevel",
            payload={"after": after_name, "board_id": board_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "action_id": action_id, "sync": "skipped_unmapped_list"}

    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    opp_payload = {
        "pipelineId": settings.GHL_PIPELINE_ID,
        "stageId": stage_id,
        "contactId": ghl_contact_id,
    }

    # Safe-mode default: DRY_RUN logs only
    if settings.DRY_RUN:
        write_audit(
            _conn,
            action="ghl.set_stage_from_trello(dry_run)",
            target="gohighlevel",
            payload={"opportunity_payload": opp_payload, "from_list": after_name, "card_id": card_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "action_id": action_id, "sync": "dry_run_logged"}

    ghl = GHLClient()
    resp = ghl.set_opportunity_stage(opp_payload)
    write_audit(
        _conn,
        action="ghl.set_stage_from_trello",
        target="gohighlevel",
        payload={"response": resp, "from_list": after_name, "card_id": card_id},
        correlation_id=correlation_id,
    )
    log_timeline_event(
        _conn,
        trello_board_id=str(board_id),
        event_type="trello_card_moved",
        event_key=action_id or f"cardMove:{card_id}",
        title="Trello Card Moved",
        human_fields={
            "Card ID": card_id,
            "Card Name": card_name,
            "From List": before_name,
            "To List": after_name,
            "GHL Stage ID": stage_id,
        },
        machine_fields={
            "card_id": card_id,
            "card_name": card_name,
            "before_list": before_name,
            "after_list": after_name,
            "ghl_stage_id": stage_id,
        },
        correlation_id=correlation_id,
    )
    return {"ok": True, "action_id": action_id, "sync": "updated"}
