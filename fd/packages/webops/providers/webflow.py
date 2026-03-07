"""Webflow API client — site info, domains, publish status.

Read-only wrapper around Webflow v1 REST API.  OpenClaw uses this to verify
that Webflow sites are published and domains are correctly attached.
"""
from __future__ import annotations

from typing import Any

import httpx

from packages.webops.http import with_retries
from packages.webops.rate_limit import RateLimiter


class WebflowClient:
    """Webflow v1 API client with rate limiting."""

    BASE = "https://api.webflow.com"

    def __init__(self, api_token: str, limiter: RateLimiter) -> None:
        self.api_token = api_token
        self.limiter = limiter

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_token}",
            "accept-version": "1.0.0",
            "Content-Type": "application/json",
        }

    def get_site(self, site_id: str) -> dict[str, Any] | None:
        """Fetch site metadata by ID."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/sites/{site_id}",
            headers=self._headers(),
            timeout=20,
        ))
        return r.json() if r.status_code == 200 else None

    def get_domains(self, site_id: str) -> dict[str, Any]:
        """List domains for a site."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/sites/{site_id}/domains",
            headers=self._headers(),
            timeout=20,
        ))
        return r.json() if r.status_code == 200 else {"error": r.text}
