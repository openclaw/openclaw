from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from packages.agencyu.ledger.chain_latest import upsert_chain_latest
from packages.agencyu.ledger.normalizer import normalize_event
from packages.agencyu.ledger.writer import LedgerWriter
from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.common.audit import write_audit
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from packages.domain.ghl_contact_index import resolve_ghl_contact_id
from packages.domain.offer_intent_v2 import (
    attach_offer_intent_board,
    get_offer_intent_by_session,
    mark_offer_intent_paid,
)
from packages.domain.trello_provisioning import provision_client_board
from packages.integrations.stripe.client import StripeClient
from services.webhook_gateway.middleware.correlation import get_or_create_correlation_id

_log = get_logger("webhook.stripe_v2")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.post("")
async def stripe_webhook_v2(req: Request):
    """V2 Stripe webhook: paid → provision Trello board → update GHL."""
    cid = get_or_create_correlation_id(req)
    raw = await req.body()
    sig = req.headers.get("stripe-signature", "")

    sc = StripeClient()
    if not sc.verify_webhook_signature(payload_raw=raw, sig_header=sig):
        raise HTTPException(status_code=400, detail="invalid_signature")

    payload = await req.json()
    event_type = payload.get("type")
    data = (payload.get("data") or {}).get("object") or {}

    write_audit(
        _conn,
        action="stripe.webhook_v2.received",
        target="stripe",
        payload={"type": event_type},
        correlation_id=cid,
    )

    if event_type == "checkout.session.completed":
        session_id = data.get("id")
        payment_intent = data.get("payment_intent")
        metadata = data.get("metadata") or {}
        offer_intent_id = metadata.get("offer_intent_id")

        # Resolve offer intent record
        row = get_offer_intent_by_session(_conn, session_id=session_id) if session_id else None
        if not row and offer_intent_id:
            row = _conn.execute(
                "SELECT * FROM checkout_offer_intents WHERE offer_intent_id=?",
                (offer_intent_id,),
            ).fetchone()
            row = dict(row) if row else None

        if not row:
            write_audit(
                _conn,
                action="stripe.webhook_v2.unmatched",
                target=session_id or "none",
                payload={"reason": "offer_intent_not_found"},
                correlation_id=cid,
            )
            return {"ok": True, "correlation_id": cid, "ignored": True}

        offer_intent_id = row["offer_intent_id"]
        mark_offer_intent_paid(
            _conn,
            offer_intent_id=offer_intent_id,
            stripe_payment_intent_id=payment_intent,
            correlation_id=cid,
        )

        # Resolve GHL contact
        ghl_contact_id = resolve_ghl_contact_id(
            _conn,
            ghl_contact_id=row.get("ghl_contact_id") or metadata.get("ghl_contact_id"),
            email=row.get("email"),
            phone=row.get("phone"),
            trello_board_id=None,
            correlation_id=cid,
        )
        if not ghl_contact_id:
            write_audit(
                _conn,
                action="stripe.webhook_v2.missing_ghl_contact",
                target=offer_intent_id,
                payload={},
                correlation_id=cid,
            )
            return {
                "ok": True,
                "correlation_id": cid,
                "needs_manual": True,
                "reason": "missing_ghl_contact",
            }

        # Provision Trello board
        customer_details = data.get("customer_details") or {}
        client_name = customer_details.get("name") or row.get("email") or f"Client {ghl_contact_id}"
        prov = provision_client_board(
            _conn,
            ghl_contact_id=ghl_contact_id,
            client_display_name=client_name,
            email=row.get("email"),
            phone=row.get("phone"),
            correlation_id=cid,
        )

        if prov.get("trello_board_id"):
            attach_offer_intent_board(
                _conn,
                offer_intent_id=offer_intent_id,
                trello_board_id=prov["trello_board_id"],
                correlation_id=cid,
            )

        # ── Write checkout_paid event to attribution ledger ──
        _write_stripe_ledger_event(
            event_type="checkout_paid",
            data=data,
            metadata=metadata,
            correlation_id=cid,
        )

        return {
            "ok": True,
            "correlation_id": cid,
            "offer_intent_id": offer_intent_id,
            "provisioning": prov,
        }

    # ── Stripe refund → refund_issued event ──
    if event_type == "charge.refunded":
        _write_stripe_ledger_event(
            event_type="refund_issued",
            data=data,
            metadata=data.get("metadata") or {},
            correlation_id=cid,
        )

    return {"ok": True, "correlation_id": cid}


def _write_stripe_ledger_event(
    *,
    event_type: str,
    data: dict,
    metadata: dict,
    correlation_id: str,
) -> None:
    """Write a Stripe event to the attribution ledger with idempotent insert.

    Resolves chain_id from metadata (combo_id + ghl_contact_id) or skips
    if attribution chain cannot be resolved.
    """
    combo_id = metadata.get("combo_id") or metadata.get("utm_campaign")
    chain_id = metadata.get("chain_id")
    brand = metadata.get("brand", "")

    if not chain_id and not combo_id:
        _log.debug(
            "stripe_ledger_skip_no_chain",
            extra={"event_type": event_type, "correlation_id": correlation_id},
        )
        return

    # Build chain_id from combo_id if not explicitly provided
    ghl_contact_id = metadata.get("ghl_contact_id", "")
    if not chain_id:
        chain_id = f"chain_{combo_id}_{ghl_contact_id}" if ghl_contact_id else f"chain_{combo_id}"

    ts = utc_now_iso()

    # Build payload
    payload: dict = {"correlation_id": correlation_id}
    if event_type == "checkout_paid":
        amount = data.get("amount_total") or data.get("amount_paid") or 0
        payload["amount"] = amount
        payload["amount_usd"] = amount / 100.0 if amount > 0 else 0.0
        payload["stripe_session_id"] = data.get("id", "")
        payload["payment_intent"] = data.get("payment_intent", "")
    elif event_type == "refund_issued":
        amount_refunded = data.get("amount_refunded") or 0
        payload["amount"] = amount_refunded
        payload["refund_amount_usd"] = amount_refunded / 100.0 if amount_refunded > 0 else 0.0
        payload["charge_id"] = data.get("id", "")

    try:
        # Ensure chain exists
        ledger = AttributionLedger(_conn)
        ledger.upsert_chain(
            chain_id=chain_id,
            brand=brand,
            combo_id=combo_id or "",
            ids={"ghl_contact_id": ghl_contact_id or None,
                 "stripe_customer_id": data.get("customer")},
        )

        # Normalize and write
        event = normalize_event(
            _conn,
            chain_id=chain_id,
            stage=event_type,
            source="stripe",
            ts=ts,
            payload=payload,
        )
        writer = LedgerWriter(_conn)
        writer.insert_event(event)

        # Update chain latest
        upsert_chain_latest(
            _conn,
            chain_id=chain_id,
            brand=brand,
            combo_id=combo_id or "",
            stage=event.normalized_stage,
            ts=ts,
        )
    except Exception:
        _log.warning(
            "stripe_ledger_write_error",
            extra={"event_type": event_type, "correlation_id": correlation_id},
            exc_info=True,
        )
