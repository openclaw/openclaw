from __future__ import annotations

from fastapi import APIRouter, Request

from packages.agencyu.ledger.chain_latest import upsert_chain_latest
from packages.agencyu.ledger.normalizer import normalize_event
from packages.agencyu.ledger.writer import LedgerWriter
from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.common.audit import write_audit
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from packages.domain.stage_sync_bidirectional import ghl_stage_to_trello_lifecycle_move
from services.webhook_gateway.middleware.correlation import get_or_create_correlation_id

_log = get_logger("webhook.ghl_stage_sync")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.post("")
async def ghl_stage_webhook(req: Request):
    """GHL stage change → move Trello lifecycle card to matching list."""
    cid = get_or_create_correlation_id(req)
    payload = await req.json()

    # Tolerant parse: GHL webhook payloads vary by configuration
    contact_id = payload.get("contactId") or (payload.get("contact") or {}).get("id")
    stage = (
        payload.get("stage")
        or payload.get("newStage")
        or (payload.get("opportunity") or {}).get("stage")
    )

    write_audit(
        _conn,
        action="ghl.stage_webhook.received",
        target=contact_id or "unknown",
        payload={"has_stage": bool(stage)},
        correlation_id=cid,
    )

    if contact_id and stage:
        res = ghl_stage_to_trello_lifecycle_move(
            _conn,
            ghl_contact_id=contact_id,
            ghl_stage=stage,
            correlation_id=cid,
        )

        # ── Write appointment event to attribution ledger ──
        _write_ghl_appointment_event(
            payload=payload,
            contact_id=contact_id,
            stage=stage,
            correlation_id=cid,
        )

        return {"ok": True, "correlation_id": cid, "stage_sync": res}

    return {"ok": True, "correlation_id": cid, "ignored": True}


# Stages that map to booking_complete, call_showed, or call_no_show for ledger ingestion
_BOOKING_STAGES = {"appointmentScheduled", "appointment_scheduled", "booked"}
_SHOWED_STAGES = {
    "appointmentCompleted", "appointment_completed",
    "call_attended", "appointment_attended", "showed",
}
_NO_SHOW_STAGES = {"noShow", "no_show", "no-show", "missed"}


def _write_ghl_appointment_event(
    *,
    payload: dict,
    contact_id: str,
    stage: str,
    correlation_id: str,
) -> None:
    """Write a GHL appointment event to the attribution ledger.

    Maps GHL stage names to canonical stages:
      appointmentScheduled → booking_complete
      appointmentCompleted → call_showed
      noShow              → call_no_show

    Extracts setter_id from payload if present (for setter scoring).
    Always sets appointment_key="ghl:<appointment_id>" and calendar_source="ghl"
    for cross-source dedup with Calendly.
    """
    # Only ingest appointment-related stages
    if stage not in _BOOKING_STAGES and stage not in _SHOWED_STAGES and stage not in _NO_SHOW_STAGES:
        return

    metadata = payload.get("metadata") or payload.get("customData") or {}
    combo_id = (
        metadata.get("combo_id")
        or metadata.get("utm_campaign")
        or payload.get("utm_campaign")
        or ""
    )
    brand = metadata.get("brand", "")
    chain_id = metadata.get("chain_id")

    if not chain_id:
        chain_id = f"chain_{combo_id}_{contact_id}" if combo_id else f"chain_ghl_{contact_id}"

    # Extract appointment_id for cross-source dedup key
    appointment_id = (
        payload.get("appointmentId")
        or payload.get("appointment_id")
        or (payload.get("appointment") or {}).get("id")
        or ""
    )

    # Extract setter_id from various GHL payload locations
    setter_id = (
        payload.get("assignedTo")
        or payload.get("assigned_to")
        or (payload.get("calendar") or {}).get("assignedUserId")
        or metadata.get("setter_id")
        or ""
    )

    ts = utc_now_iso()

    # Determine canonical stage
    if stage in _BOOKING_STAGES:
        canonical_stage = "booking_complete"
    elif stage in _SHOWED_STAGES:
        canonical_stage = "call_showed"
    else:
        canonical_stage = "call_no_show"

    appointment_key = f"ghl:{appointment_id}" if appointment_id else ""

    event_payload: dict = {
        "correlation_id": correlation_id,
        "ghl_contact_id": contact_id,
        "ghl_raw_stage": stage,
        "appointment_key": appointment_key,
        "calendar_source": "ghl",
        "ghl_appointment_id": appointment_id,
    }
    if setter_id:
        event_payload["setter_id"] = setter_id

    try:
        ledger = AttributionLedger(_conn)
        ledger.upsert_chain(
            chain_id=chain_id,
            brand=brand,
            combo_id=combo_id,
            ids={"ghl_contact_id": contact_id},
        )

        event = normalize_event(
            _conn,
            chain_id=chain_id,
            stage=canonical_stage,
            source="ghl",
            ts=ts,
            payload=event_payload,
        )
        writer = LedgerWriter(_conn)
        writer.insert_event(event)

        upsert_chain_latest(
            _conn,
            chain_id=chain_id,
            brand=brand,
            combo_id=combo_id,
            stage=event.normalized_stage,
            ts=ts,
        )
    except Exception:
        _log.warning(
            "ghl_ledger_write_error",
            extra={"stage": stage, "contact_id": contact_id},
            exc_info=True,
        )
