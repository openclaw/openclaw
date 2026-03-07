from __future__ import annotations

import hashlib
import hmac
from typing import Any

import httpx
import stripe

from packages.common.config import settings


class StripeClient:
    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key or settings.STRIPE_SECRET_KEY
        stripe.api_key = self.api_key

    def create_checkout_session(
        self,
        *,
        price_id: str,
        customer_email: str,
        success_url: str,
        cancel_url: str,
        metadata: dict[str, str],
        quantity: int = 1,
    ) -> dict[str, Any]:
        # Used post-call (human closes, system creates link). Keep for Day-3 use.
        session = stripe.checkout.Session.create(
            mode="payment",
            customer_email=customer_email,
            line_items=[{"price": price_id, "quantity": quantity}],
            success_url=success_url,
            cancel_url=cancel_url,
            metadata=metadata,
        )
        return session

    def create_ad_hoc_checkout_session(
        self,
        *,
        amount_cents: int,
        currency: str,
        description: str,
        success_url: str,
        cancel_url: str,
        metadata: dict[str, str],
        customer_email: str | None = None,
    ) -> dict[str, Any]:
        """Create a checkout session with ad-hoc pricing (no pre-created price)."""
        data: dict[str, str] = {
            "mode": "payment",
            "success_url": success_url,
            "cancel_url": cancel_url,
            "line_items[0][price_data][currency]": currency,
            "line_items[0][price_data][product_data][name]": description,
            "line_items[0][price_data][unit_amount]": str(amount_cents),
            "line_items[0][quantity]": "1",
        }
        if customer_email:
            data["customer_email"] = customer_email
        for k, v in (metadata or {}).items():
            data[f"metadata[{k}]"] = v

        resp = httpx.post(
            "https://api.stripe.com/v1/checkout/sessions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            data=data,
            timeout=20.0,
        )
        resp.raise_for_status()
        return resp.json()

    def verify_webhook_event(self, *, payload_bytes: bytes, sig_header: str) -> dict[str, Any]:
        # This MUST be real verification (even in DRY_RUN).
        event = stripe.Webhook.construct_event(
            payload=payload_bytes,
            sig_header=sig_header,
            secret=settings.STRIPE_WEBHOOK_SECRET,
        )
        return event

    def verify_webhook_signature(self, *, payload_raw: bytes, sig_header: str) -> bool:
        """Lightweight HMAC signature check (no stripe SDK needed).

        If STRIPE_WEBHOOK_SECRET is not set, skip verification (dev-mode).
        """
        if not settings.STRIPE_WEBHOOK_SECRET:
            return True
        if not sig_header:
            return False
        parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
        t = parts.get("t")
        v1 = parts.get("v1")
        if not t or not v1:
            return False
        signed_payload = f"{t}.".encode() + payload_raw
        mac = hmac.new(
            settings.STRIPE_WEBHOOK_SECRET.encode("utf-8"),
            signed_payload,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(mac, v1)
