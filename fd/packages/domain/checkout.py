from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.offer_intent_v2 import create_offer_intent, set_offer_intent_stripe_session
from packages.integrations.stripe.client import StripeClient

# Simple v1 offer catalog
OFFER_CATALOG: dict[str, dict[str, Any]] = {
    "FD_ROLLOUT_800": {"amount_cents": 80000, "description": "Full Digital Rollout Package"},
    "FD_SUB_STARTER": {"amount_cents": 150000, "description": "Full Digital Subscription Starter"},
}


def create_checkout_link(
    conn: sqlite3.Connection,
    *,
    offer_code: str,
    ghl_contact_id: str | None,
    email: str | None,
    phone: str | None,
    correlation_id: str | None,
) -> dict[str, Any]:
    offer = OFFER_CATALOG.get(offer_code)
    if not offer:
        return {"ok": False, "error": "unknown_offer_code"}

    created = create_offer_intent(
        conn,
        ghl_contact_id=ghl_contact_id,
        email=email,
        phone=phone,
        offer_code=offer_code,
        amount_cents=offer["amount_cents"],
        currency=settings.OFFER_CURRENCY,
        correlation_id=correlation_id,
    )
    offer_intent_id = created["offer_intent_id"]

    # Dev-mode dry run
    if settings.DRY_RUN or settings.SAFE_MODE or not settings.STRIPE_SECRET_KEY:
        url = f"https://example.com/checkout/dry-run?offer_intent_id={offer_intent_id}"
        write_audit(
            conn,
            action="stripe.checkout.simulated",
            target=offer_intent_id,
            payload={"offer_code": offer_code, "url": url},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "offer_intent_id": offer_intent_id, "url": url}

    sc = StripeClient()
    session = sc.create_ad_hoc_checkout_session(
        amount_cents=offer["amount_cents"],
        currency=settings.OFFER_CURRENCY,
        description=offer["description"],
        success_url=settings.STRIPE_SUCCESS_URL,
        cancel_url=settings.STRIPE_CANCEL_URL,
        customer_email=email,
        metadata={
            "offer_intent_id": offer_intent_id,
            "ghl_contact_id": ghl_contact_id or "",
            "offer_code": offer_code,
            "correlation_id": correlation_id or "",
        },
    )
    set_offer_intent_stripe_session(
        conn,
        offer_intent_id=offer_intent_id,
        stripe_checkout_session_id=session["id"],
        correlation_id=correlation_id,
    )
    return {
        "ok": True,
        "mode": "live",
        "offer_intent_id": offer_intent_id,
        "url": session.get("url"),
        "stripe_session_id": session["id"],
    }
