from __future__ import annotations

from fastapi import APIRouter, Depends

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError
from packages.common.idempotency import seen_or_mark
from packages.common.ids import new_id
from packages.common.logging import get_logger, log_error, log_info
from packages.domain.offer_intent import write_offer_intent
from packages.integrations.ghl.client import GHLClient
from packages.integrations.manychat.client import ManyChatClient
from packages.integrations.manychat.models import ManyChatIncoming
from services.webhook_gateway.security import require_webhook_secret

logger = get_logger("webhook.manychat")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.post("")
def manychat_webhook(payload: ManyChatIncoming, _: None = Depends(require_webhook_secret)) -> dict:
    correlation_id = new_id("corr")
    event_id = payload.event_id or new_id("evt")

    log_info(
        logger,
        "manychat webhook received",
        extra={"correlation_id": correlation_id, "event_id": event_id, "brand": payload.brand},
    )

    if seen_or_mark(_conn, key=f"manychat:{event_id}"):
        log_info(logger, "idempotency hit - ignoring duplicate", extra={"event_id": event_id})
        return {"ok": True, "duplicate": True, "correlation_id": correlation_id}

    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    # OfferIntent persistence (pre-call intent capture)
    offer_intent = str(payload.answers.get("offer_intent") or payload.answers.get("need") or "")
    budget = str(payload.answers.get("budget") or "")
    timeline = str(payload.answers.get("timeline") or "")

    write_offer_intent(
        _conn,
        correlation_id=correlation_id,
        brand=payload.brand,
        instagram_handle=payload.instagram_handle,
        email=payload.email,
        phone=payload.phone,
        offer_intent=offer_intent,
        budget=budget,
        timeline=timeline,
        raw_answers=payload.answers or {},
    )

    write_audit(
        _conn,
        action="offer_intent.captured",
        target="localdb",
        payload={"offer_intent": offer_intent, "budget": budget, "timeline": timeline},
        correlation_id=correlation_id,
    )

    # Prepare tags
    tags = [settings.TAG_LEAD, settings.TAG_FULLDIGITAL if payload.brand != "cutmv" else settings.TAG_CUTMV]

    # Minimal contact payload
    contact_payload = {
        "name": " ".join([x for x in [payload.first_name, payload.last_name] if x]) or payload.instagram_handle,
        "email": payload.email,
        "phone": payload.phone,
        "tags": tags,
        "customField": {
            "ExternalCorrelationID": correlation_id,
            "OfferIntent": str(payload.answers.get("offer_intent", ""))[:500],
            "BudgetRange": str(payload.answers.get("budget", ""))[:100],
            "Timeline": str(payload.answers.get("timeline", ""))[:100],
            "SourcePlatform": "instagram",
        },
    }

    # In dev, DRY_RUN defaults true: we record what we would do, but skip writes.
    ghl = GHLClient()
    manychat = ManyChatClient()

    action_summary = {"dry_run": settings.DRY_RUN, "ghl_contact": "skipped", "manychat_msg": "skipped"}

    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    if settings.DRY_RUN:
        write_audit(
            _conn,
            action="ghl.upsert_contact(dry_run)",
            target="gohighlevel",
            payload={"contact_payload": contact_payload},
            correlation_id=correlation_id,
        )
        action_summary["ghl_contact"] = "dry_run_logged"
    else:
        try:
            resp = ghl.upsert_contact(contact_payload)
            write_audit(
                _conn,
                action="ghl.upsert_contact",
                target="gohighlevel",
                payload={"response": resp},
                correlation_id=correlation_id,
            )
            action_summary["ghl_contact"] = "created_or_updated"
        except Exception as e:
            log_error(logger, "ghl upsert failed", extra={"error": str(e), "correlation_id": correlation_id})
            raise

    # Send booking link message
    text = f"Got you — here's the booking link: {settings.BOOKING_LINK}"
    if settings.DRY_RUN:
        write_audit(
            _conn,
            action="manychat.send_text(dry_run)",
            target="manychat",
            payload={"subscriber_id": payload.subscriber_id, "text": text},
            correlation_id=correlation_id,
        )
        action_summary["manychat_msg"] = "dry_run_logged"
    else:
        if payload.subscriber_id:
            resp = manychat.send_text(payload.subscriber_id, text)
            write_audit(
                _conn,
                action="manychat.send_text",
                target="manychat",
                payload={"response": resp},
                correlation_id=correlation_id,
            )
            action_summary["manychat_msg"] = "sent"
        else:
            action_summary["manychat_msg"] = "skipped_missing_subscriber_id"

    return {"ok": True, "correlation_id": correlation_id, "event_id": event_id, "summary": action_summary}
