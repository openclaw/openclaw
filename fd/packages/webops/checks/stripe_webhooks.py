"""Stripe webhook integrity check.

Verifies that all expected webhook endpoints exist and have correct
event subscriptions configured.
"""
from __future__ import annotations

from typing import Any

from packages.webops.providers.stripe import StripeWebhookClient


def run_stripe_webhook_integrity(
    stripe_client: StripeWebhookClient,
    *,
    expected_endpoints: list[dict[str, Any]],
) -> dict[str, Any]:
    """Check Stripe webhook endpoints against expected config."""
    result = stripe_client.verify_expected_webhooks(expected_endpoints)
    ok = len(result["missing"]) == 0 and len(result["mismatched"]) == 0
    return {"ok": ok, **result}
