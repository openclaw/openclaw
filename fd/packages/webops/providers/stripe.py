"""Stripe client — webhook endpoint verification.

OpenClaw does NOT process payments. It verifies that the expected webhook
endpoints exist in Stripe and have the correct event subscriptions.
Uses the Stripe REST API directly (no stripe SDK dependency).
"""
from __future__ import annotations

from typing import Any

import httpx

from packages.webops.http import with_retries
from packages.webops.rate_limit import RateLimiter


class StripeWebhookClient:
    """Stripe webhook endpoint verifier using REST API."""

    BASE = "https://api.stripe.com/v1"

    def __init__(self, secret_key: str, limiter: RateLimiter) -> None:
        self.secret_key = secret_key
        self.limiter = limiter

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.secret_key}"}

    def list_webhook_endpoints(self, limit: int = 100) -> list[dict[str, Any]]:
        """List all webhook endpoints in the Stripe account."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/webhook_endpoints",
            headers=self._headers(),
            params={"limit": limit},
            timeout=20,
        ))
        data = r.json()
        return data.get("data", [])

    def verify_expected_webhooks(
        self,
        expected: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Compare expected webhook endpoints against Stripe.

        Returns missing URLs and mismatched event subscriptions.
        """
        existing = self.list_webhook_endpoints()
        by_url: dict[str, dict[str, Any]] = {w.get("url", ""): w for w in existing}

        missing: list[str] = []
        mismatched: list[dict[str, Any]] = []

        for exp in expected:
            url = exp["url"]
            events = set(exp.get("events", []))
            webhook = by_url.get(url)
            if not webhook:
                missing.append(url)
                continue
            enabled = set(webhook.get("enabled_events", []) or [])
            if events and not events.issubset(enabled):
                mismatched.append({
                    "url": url,
                    "missing_events": sorted(events - enabled),
                })

        return {
            "missing": missing,
            "mismatched": mismatched,
            "count_existing": len(existing),
        }
