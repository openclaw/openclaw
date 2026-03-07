"""Cloudflare API client — DNS records, SSL settings, cache purge.

Thin wrapper around Cloudflare v4 REST API with rate limiting and retries.
Used by WebOps checks to verify DNS + SSL configuration matches sites.yaml.

OpenClaw does NOT manage Cloudflare auth flows — it only reads/writes zone
config using an API token from tool_access.yaml.
"""
from __future__ import annotations

from typing import Any

import httpx

from packages.webops.http import with_retries
from packages.webops.rate_limit import RateLimiter


class CloudflareClient:
    """Cloudflare v4 API client with rate limiting."""

    BASE = "https://api.cloudflare.com/client/v4"

    def __init__(self, api_token: str, limiter: RateLimiter) -> None:
        self.api_token = api_token
        self.limiter = limiter

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }

    # ── Zones ──────────────────────────────────────────

    def get_zone_id(self, zone_name: str) -> str | None:
        """Look up a zone by name, return its ID or None."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/zones",
            headers=self._headers(),
            params={"name": zone_name},
            timeout=20,
        ))
        data = r.json()
        if not data.get("success"):
            return None
        results = data.get("result", [])
        return results[0]["id"] if results else None

    # ── DNS ────────────────────────────────────────────

    def list_dns_records(self, zone_id: str) -> list[dict[str, Any]]:
        """Return all DNS records for a zone."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/zones/{zone_id}/dns_records",
            headers=self._headers(),
            timeout=20,
        ))
        data = r.json()
        return data.get("result", []) if data.get("success") else []

    # ── SSL ────────────────────────────────────────────

    def get_zone_settings_ssl(self, zone_id: str) -> dict[str, Any]:
        """Read SSL-related zone settings (ssl, always_use_https, auto rewrites)."""
        out: dict[str, Any] = {}
        for setting in ("ssl", "always_use_https", "automatic_https_rewrites"):
            self.limiter.wait()
            r = with_retries(lambda s=setting: httpx.get(
                f"{self.BASE}/zones/{zone_id}/settings/{s}",
                headers=self._headers(),
                timeout=20,
            ))
            data = r.json()
            if data.get("success"):
                out[setting] = data.get("result", {}).get("value")
        return out

    # ── Cache ──────────────────────────────────────────

    def purge_cache(
        self,
        zone_id: str,
        *,
        purge_everything: bool = False,
        urls: list[str] | None = None,
    ) -> dict[str, Any]:
        """Purge cache for a zone — everything or specific URLs."""
        payload: dict[str, Any] = (
            {"purge_everything": True}
            if purge_everything
            else {"files": urls or []}
        )
        self.limiter.wait()
        r = with_retries(lambda: httpx.post(
            f"{self.BASE}/zones/{zone_id}/purge_cache",
            headers=self._headers(),
            json=payload,
            timeout=30,
        ))
        return r.json()
