from __future__ import annotations

from fastapi import APIRouter, Header
from pydantic import BaseModel

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError, WebhookAuthError
from packages.common.idempotency import seen_or_mark
from packages.common.logging import get_logger, log_info
from packages.domain.contact_map import get_board_by_contact
from packages.domain.lifecycle_cleanup import cleanup_stage_ids, run_cleanup
from packages.domain.sync import (
    get_fulfillment_by_board,
    get_primary_card_and_lists,
    parse_stage_to_list,
)
from packages.domain.timeline import log_timeline_event
from packages.integrations.ghl.client import GHLClient
from packages.integrations.ghl.parsing import extract_custom_field
from packages.integrations.trello.client import TrelloClient

logger = get_logger("webhook.ghl")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


def _require_ghl_secret(x_webhook_secret: str | None) -> None:
    if not settings.GHL_WEBHOOK_SHARED_SECRET:
        raise WebhookAuthError("GHL_WEBHOOK_SHARED_SECRET not configured")
    if x_webhook_secret != settings.GHL_WEBHOOK_SHARED_SECRET:
        raise WebhookAuthError("Invalid GHL webhook secret")


class GHLStageChanged(BaseModel):
    event_id: str
    ghl_contact_id: str
    pipeline_id: str | None = None
    stage_id: str
    trello_board_id: str | None = None


@router.post("")
def ghl_webhook(
    payload: GHLStageChanged,
    x_webhook_secret: str | None = Header(default=None),
) -> dict:
    _require_ghl_secret(x_webhook_secret)

    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    # Idempotency
    if seen_or_mark(_conn, key=f"ghl:{payload.event_id}"):
        return {"ok": True, "duplicate": True, "event_id": payload.event_id}

    log_info(logger, "ghl webhook received", extra={"event_id": payload.event_id, "stage_id": payload.stage_id})

    # Resolution chain: (1) payload → (2) local contact_board_map → (3) GHL custom field → (4) fail
    board_id = payload.trello_board_id

    # (2) Local fallback: contact -> board map
    if not board_id:
        mapped_board_id, mapped_primary_card_id = get_board_by_contact(_conn, payload.ghl_contact_id)
        if mapped_board_id:
            board_id = mapped_board_id
            write_audit(
                _conn,
                action="trello_board_id.resolved_from_local_map",
                target="localdb",
                payload={
                    "event_id": payload.event_id,
                    "ghl_contact_id": payload.ghl_contact_id,
                    "resolved_board_id": board_id,
                    "primary_card_id": mapped_primary_card_id,
                },
            )

    # (3) Last fallback: fetch GHL contact custom field
    if not board_id:
        ghl = GHLClient()
        try:
            contact = ghl.get_contact(payload.ghl_contact_id)
        except Exception as e:
            write_audit(
                _conn,
                action="ghl.get_contact.failed",
                target="gohighlevel",
                payload={"event_id": payload.event_id, "ghl_contact_id": payload.ghl_contact_id, "error": str(e)},
            )
            return {"ok": True, "event_id": payload.event_id, "sync": "skipped_contact_fetch_failed"}

        resolved = extract_custom_field(contact, settings.GHL_CUSTOM_FIELD_TRELLO_BOARD_ID_KEY)

        if resolved:
            board_id = resolved
            write_audit(
                _conn,
                action="trello_board_id.resolved_from_ghl",
                target="gohighlevel",
                payload={
                    "event_id": payload.event_id,
                    "ghl_contact_id": payload.ghl_contact_id,
                    "resolved_board_id": board_id,
                    "field_key": settings.GHL_CUSTOM_FIELD_TRELLO_BOARD_ID_KEY,
                },
            )
        else:
            write_audit(
                _conn,
                action="trello_board_id.missing_in_ghl",
                target="gohighlevel",
                payload={
                    "event_id": payload.event_id,
                    "ghl_contact_id": payload.ghl_contact_id,
                    "field_key": settings.GHL_CUSTOM_FIELD_TRELLO_BOARD_ID_KEY,
                },
            )
            return {"ok": True, "event_id": payload.event_id, "sync": "skipped_missing_board_id"}

    # Lifecycle cleanup trigger (GHL stage -> archive)
    if payload.stage_id in set(cleanup_stage_ids()):
        job = get_fulfillment_by_board(_conn, str(board_id))
        offer_key = job.get("offer_key") if job else None
        result = run_cleanup(
            _conn,
            source="ghl",
            source_event_id=payload.event_id,
            trello_board_id=str(board_id),
            correlation_id=None,
            reason=f"ghl_stage:{payload.stage_id}",
            offer_key=str(offer_key) if offer_key else None,
        )
        return {"ok": True, "event_id": payload.event_id, "sync": "cleanup_triggered", "cleanup": result}

    job = get_fulfillment_by_board(_conn, str(board_id))
    if not job:
        write_audit(
            _conn,
            action="trello.sync.skipped_no_fulfillment_job",
            target="trello",
            payload={"board_id": board_id, "event_id": payload.event_id},
        )
        return {"ok": True, "event_id": payload.event_id, "sync": "skipped_no_job"}

    correlation_id = job.get("correlation_id")
    meta_json = str(job.get("metadata_json") or "")
    primary_card_id, list_ids_by_name = get_primary_card_and_lists(meta_json)

    if not primary_card_id:
        write_audit(
            _conn,
            action="trello.sync.skipped_missing_primary_card",
            target="trello",
            payload={"board_id": board_id, "event_id": payload.event_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "event_id": payload.event_id, "sync": "skipped_missing_primary_card"}

    # Map stage_id -> Trello list name
    stage_to_list = parse_stage_to_list()
    target_list_name = stage_to_list.get(payload.stage_id)
    if not target_list_name:
        write_audit(
            _conn,
            action="trello.sync.skipped_unmapped_stage",
            target="trello",
            payload={"stage_id": payload.stage_id, "board_id": board_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "event_id": payload.event_id, "sync": "skipped_unmapped_stage"}

    # Resolve target list id from stored metadata; fallback to Trello API
    target_list_id = list_ids_by_name.get(target_list_name)

    tc = TrelloClient()
    if not target_list_id:
        lists = tc.get_lists(board_id=str(board_id))
        for lst in lists:
            if str(lst.get("name")) == target_list_name:
                target_list_id = str(lst.get("id"))
                break

    if not target_list_id:
        write_audit(
            _conn,
            action="trello.sync.failed_target_list_not_found",
            target="trello",
            payload={"target_list_name": target_list_name, "board_id": board_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "event_id": payload.event_id, "sync": "failed_list_not_found"}

    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    if settings.DRY_RUN:
        write_audit(
            _conn,
            action="trello.move_primary_card(dry_run)",
            target="trello",
            payload={"card_id": primary_card_id, "to_list_name": target_list_name, "to_list_id": target_list_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "event_id": payload.event_id, "sync": "dry_run_logged"}

    resp = tc.move_card(card_id=primary_card_id, list_id=target_list_id)
    write_audit(
        _conn,
        action="trello.move_primary_card",
        target="trello",
        payload={"response": resp, "to_list_name": target_list_name},
        correlation_id=correlation_id,
    )
    log_timeline_event(
        _conn,
        trello_board_id=str(board_id),
        event_type="ghl_stage_changed",
        event_key=payload.event_id,
        title="GHL Stage Changed",
        human_fields={
            "GHL Contact ID": payload.ghl_contact_id,
            "Stage ID": payload.stage_id,
            "Target List": target_list_name,
        },
        machine_fields={
            "ghl_contact_id": payload.ghl_contact_id,
            "stage_id": payload.stage_id,
            "target_list_name": target_list_name,
        },
        correlation_id=correlation_id,
    )
    return {"ok": True, "event_id": payload.event_id, "sync": "moved"}
