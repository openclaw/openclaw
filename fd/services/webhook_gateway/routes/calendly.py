"""Calendly webhook ingestion — secondary source for booking + attendance events.

GHL is the primary truth for call_showed. Calendly acts as:
  (a) gap-filler when GHL doesn't emit a booking/showed event
  (b) early signal that a booking happened before GHL updates

All Calendly events carry calendar_source="calendly" and
appointment_key="cal:<invitee_uuid>" so the rollup precedence logic
can prefer GHL records and avoid double-counting.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from packages.agencyu.config.setter_mapping import resolve_setter_id_by_email
from packages.agencyu.ledger.chain_latest import upsert_chain_latest
from packages.agencyu.ledger.normalizer import normalize_event
from packages.agencyu.ledger.writer import LedgerWriter
from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.common.audit import write_audit
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.middleware.correlation import get_or_create_correlation_id

_log = get_logger("webhook.calendly")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.post("")
async def calendly_webhook(req: Request):
    """Calendly webhook → booking_complete or booking_canceled to attribution ledger."""
    cid = get_or_create_correlation_id(req)
    evt = await req.json()

    write_audit(
        _conn,
        action="calendly.webhook.received",
        target="calendly",
        payload={"event": evt.get("event")},
        correlation_id=cid,
    )

    _handle_calendly_event(evt, correlation_id=cid)
    return {"ok": True, "correlation_id": cid}


def _handle_calendly_event(evt: dict, *, correlation_id: str) -> None:
    """Route Calendly event to the correct ledger stage."""
    etype = evt.get("event") or evt.get("type")
    payload_data = evt.get("payload") or evt

    if etype in ("invitee.created", "invitee_created"):
        _ingest_booking(payload_data, etype=etype, correlation_id=correlation_id)
    elif etype in ("invitee.canceled", "invitee_canceled"):
        _ingest_cancellation(payload_data, etype=etype, correlation_id=correlation_id)


def _ingest_booking(payload_data: dict, *, etype: str, correlation_id: str) -> None:
    """invitee.created → booking_complete event with calendar_source=calendly."""
    invitee = payload_data.get("invitee") or {}
    event_info = payload_data.get("event") or {}

    invitee_uuid = invitee.get("uuid") or _extract_uuid(invitee.get("uri"))
    email = invitee.get("email")
    name = invitee.get("name")
    event_uuid = event_info.get("uuid") or _extract_uuid(event_info.get("uri"))

    if not invitee_uuid:
        _log.debug("calendly_skip_no_invitee_uuid", extra={"correlation_id": correlation_id})
        return

    # Resolve chain from Calendly identifiers
    chain_id, combo_id, brand = _resolve_chain(
        invitee_uuid=invitee_uuid,
        email=email,
        payload_data=payload_data,
    )

    # Resolve setter from event organizer email (best-effort)
    organizer_email = _extract_organizer_email(event_info)
    setter_id = resolve_setter_id_by_email(organizer_email) if organizer_email else None

    appointment_key = f"cal:{invitee_uuid}"
    ts = invitee.get("created_at") or utc_now_iso()

    event_payload: dict = {
        "correlation_id": correlation_id,
        "appointment_key": appointment_key,
        "calendar_source": "calendly",
        "cal_invitee_uuid": invitee_uuid,
        "cal_event_uuid": event_uuid,
        "email": email,
        "name": name,
        "start_time": event_info.get("start_time"),
        "end_time": event_info.get("end_time"),
    }
    if setter_id:
        event_payload["setter_id"] = setter_id

    try:
        ledger = AttributionLedger(_conn)
        ledger.upsert_chain(
            chain_id=chain_id,
            brand=brand,
            combo_id=combo_id,
            ids={},
        )

        event = normalize_event(
            _conn,
            chain_id=chain_id,
            stage="booking_complete",
            source="calendly",
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
            "calendly_booking_write_error",
            extra={"invitee_uuid": invitee_uuid},
            exc_info=True,
        )


def _ingest_cancellation(payload_data: dict, *, etype: str, correlation_id: str) -> None:
    """invitee.canceled → booking_canceled event."""
    invitee = payload_data.get("invitee") or {}
    invitee_uuid = invitee.get("uuid") or _extract_uuid(invitee.get("uri"))
    email = invitee.get("email")

    if not invitee_uuid:
        return

    chain_id, combo_id, brand = _resolve_chain(
        invitee_uuid=invitee_uuid,
        email=email,
        payload_data=payload_data,
    )

    appointment_key = f"cal:{invitee_uuid}"
    ts = invitee.get("canceled_at") or invitee.get("updated_at") or utc_now_iso()

    event_payload: dict = {
        "correlation_id": correlation_id,
        "appointment_key": appointment_key,
        "calendar_source": "calendly",
        "cal_invitee_uuid": invitee_uuid,
        "email": email,
        "reason": invitee.get("cancel_reason"),
    }

    try:
        ledger = AttributionLedger(_conn)
        ledger.upsert_chain(
            chain_id=chain_id,
            brand=brand,
            combo_id=combo_id,
            ids={},
        )

        event = normalize_event(
            _conn,
            chain_id=chain_id,
            stage="booking_canceled",
            source="calendly",
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
            "calendly_cancel_write_error",
            extra={"invitee_uuid": invitee_uuid},
            exc_info=True,
        )


# ── helpers ──


def _resolve_chain(
    *,
    invitee_uuid: str,
    email: str | None,
    payload_data: dict,
) -> tuple[str, str, str]:
    """Resolve chain_id, combo_id, brand from Calendly payload.

    Uses tracking UTMs if embedded in the scheduling link or metadata.
    Falls back to a deterministic chain_id from invitee_uuid.
    """
    tracking = payload_data.get("tracking") or {}
    metadata = payload_data.get("metadata") or {}

    combo_id = (
        tracking.get("utm_campaign")
        or metadata.get("combo_id")
        or ""
    )
    brand = metadata.get("brand") or tracking.get("utm_source") or ""
    chain_id = metadata.get("chain_id")

    if not chain_id:
        anchor = email or invitee_uuid
        chain_id = f"chain_{combo_id}_{anchor}" if combo_id else f"chain_cal_{anchor}"

    return chain_id, combo_id, brand


def _extract_uuid(uri: str | None) -> str | None:
    """Extract trailing UUID segment from a Calendly API URI."""
    if not uri:
        return None
    parts = uri.rstrip("/").split("/")
    return parts[-1] if parts else None


def _extract_organizer_email(event_info: dict) -> str | None:
    """Best-effort extraction of event organizer/owner email from Calendly event."""
    # Calendly v2 event_memberships
    memberships = event_info.get("event_memberships") or []
    if memberships:
        user = memberships[0].get("user_email")
        if user:
            return user

    # Fallback: organizer key
    organizer = event_info.get("organizer") or {}
    return organizer.get("email")
