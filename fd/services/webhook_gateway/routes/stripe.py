from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Header, Request

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError, WebhookAuthError
from packages.common.idempotency import seen_or_mark
from packages.common.logging import get_logger, log_error, log_info
from packages.domain.fulfillment import create_fulfillment_job
from packages.domain.timeline import log_timeline_event
from packages.integrations.ghl.client import GHLClient
from packages.integrations.stripe.client import StripeClient

logger = get_logger("webhook.stripe")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


def _safe_get(d: dict[str, Any], path: list[str]) -> Any | None:
    cur: Any = d
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur


@router.post("")
async def stripe_webhook(request: Request, stripe_signature: str | None = Header(default=None)) -> dict:
    if not stripe_signature:
        raise WebhookAuthError("Missing Stripe-Signature header")

    raw = await request.body()

    # Verify signature ALWAYS (even DRY_RUN).
    sc = StripeClient()
    try:
        event = sc.verify_webhook_event(payload_bytes=raw, sig_header=stripe_signature)
    except Exception as e:
        log_error(logger, "stripe signature verification failed", extra={"error": str(e)})
        raise WebhookAuthError("Invalid Stripe signature")

    event_id = str(event.get("id", ""))
    event_type = str(event.get("type", ""))

    log_info(logger, "stripe webhook received", extra={"event_id": event_id, "type": event_type})

    if not event_id:
        raise WebhookAuthError("Stripe event missing id")

    # Idempotency for stripe events
    if seen_or_mark(_conn, key=f"stripe:{event_id}"):
        return {"ok": True, "duplicate": True, "event_id": event_id}

    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    # We only act on checkout completion right now
    if event_type != "checkout.session.completed":
        write_audit(
            _conn,
            action="stripe.event.ignored",
            target="stripe",
            payload={"event_id": event_id, "type": event_type},
        )
        return {"ok": True, "ignored": True, "event_id": event_id}

    obj = event.get("data", {}).get("object", {}) if isinstance(event.get("data"), dict) else {}
    amount_total = _safe_get(obj, ["amount_total"])
    currency = _safe_get(obj, ["currency"])
    customer_email = _safe_get(obj, ["customer_details", "email"]) or _safe_get(obj, ["customer_email"])
    metadata = _safe_get(obj, ["metadata"]) or {}

    correlation_id = None
    if isinstance(metadata, dict):
        correlation_id = metadata.get("correlation_id") or metadata.get("ExternalCorrelationID")

    # Persist payment record (local), always.
    _conn.execute(
        """
        INSERT OR REPLACE INTO payments
        (payment_id, ts, provider, provider_event_id, status, amount_total, currency, customer_email, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(obj.get("id", f"stripe_session_{event_id}")),
            int(time.time()),
            "stripe",
            event_id,
            "paid",
            int(amount_total) if isinstance(amount_total, int) else None,
            str(currency) if currency else None,
            str(customer_email) if customer_email else None,
            json.dumps(metadata if isinstance(metadata, dict) else {}, ensure_ascii=False),
        ),
    )
    _conn.commit()

    write_audit(
        _conn,
        action="stripe.checkout.session.completed",
        target="stripe",
        payload={
            "event_id": event_id,
            "amount_total": amount_total,
            "currency": currency,
            "customer_email": customer_email,
            "metadata": metadata if isinstance(metadata, dict) else {},
        },
        correlation_id=correlation_id,
    )

    # Now: update GHL stage WON (DRY_RUN default logs only)
    ghl_contact_id = metadata.get("ghl_contact_id") if isinstance(metadata, dict) else None
    if not ghl_contact_id:
        # payment happened but no CRM link -> audit and exit
        write_audit(
            _conn,
            action="ghl.stage_won.skipped_missing_contact_id",
            target="gohighlevel",
            payload={"event_id": event_id},
            correlation_id=correlation_id,
        )
        return {"ok": True, "event_id": event_id, "won_update": "skipped_missing_contact_id"}

    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    opp_payload = {
        "pipelineId": settings.GHL_PIPELINE_ID,
        "stageId": settings.GHL_STAGE_WON_ID,
        "contactId": ghl_contact_id,
    }

    won_update_status: str
    if settings.DRY_RUN:
        write_audit(
            _conn,
            action="ghl.set_stage_won(dry_run)",
            target="gohighlevel",
            payload={"opportunity_payload": opp_payload},
            correlation_id=correlation_id,
        )
        won_update_status = "dry_run_logged"
    else:
        ghl = GHLClient()
        try:
            resp = ghl.set_opportunity_stage(opp_payload)
            write_audit(
                _conn,
                action="ghl.set_stage_won",
                target="gohighlevel",
                payload={"response": resp},
                correlation_id=correlation_id,
            )
            won_update_status = "updated"
        except Exception as e:
            log_error(logger, "ghl stage won update failed", extra={"error": str(e), "event_id": event_id})
            raise

    # Fulfillment trigger (Trello) — controlled by DRY_RUN
    offer_key = metadata.get("offer_key") if isinstance(metadata, dict) else None
    brand = metadata.get("brand", "fulldigital") if isinstance(metadata, dict) else "fulldigital"

    if not offer_key:
        offer_key = "unknown_offer"

    fulfill_result = create_fulfillment_job(
        _conn,
        brand=str(brand),
        correlation_id=correlation_id,
        ghl_contact_id=str(ghl_contact_id) if ghl_contact_id else None,
        customer_email=str(customer_email) if customer_email else None,
        offer_key=str(offer_key),
        metadata={
            "source": "stripe_webhook",
            "stripe_event_id": event_id,
            "stripe_session_id": str(obj.get("id")),
        },
    )

    board_id = fulfill_result.get("trello_board_id")
    if board_id:
        amount_display = f"{int(amount_total) / 100:.2f}" if isinstance(amount_total, int) else str(amount_total)
        log_timeline_event(
            _conn,
            trello_board_id=str(board_id),
            event_type="payment_succeeded",
            event_key=event_id,
            title="Payment Succeeded",
            human_fields={
                "Stripe Event ID": event_id,
                "Customer Email": customer_email,
                "Amount": amount_display,
                "Currency": currency,
            },
            machine_fields={
                "stripe_event_id": event_id,
                "amount": amount_total,
                "currency": currency,
                "email": customer_email,
            },
            correlation_id=correlation_id,
        )

    return {
        "ok": True,
        "event_id": event_id,
        "won_update": won_update_status,
        "fulfillment": fulfill_result,
    }
