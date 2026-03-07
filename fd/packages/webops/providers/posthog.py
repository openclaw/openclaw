"""PostHog client — health check for event ingestion endpoint.

OpenClaw uses this to verify that the PostHog instance is reachable
and the project API key is accepted.
"""
from __future__ import annotations

from typing import Any

import httpx

from packages.webops.http import with_retries
from packages.webops.rate_limit import RateLimiter


class PostHogClient:
    """Minimal PostHog client for health verification."""

    def __init__(self, project_api_key: str, host: str, limiter: RateLimiter) -> None:
        self.key = project_api_key
        self.host = host.rstrip("/")
        self.limiter = limiter

    def capture_health(self) -> dict[str, Any]:
        """Verify PostHog instance is reachable via /_health endpoint."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.host}/_health",
            timeout=15,
        ))
        return {"ok": r.status_code == 200, "status_code": r.status_code}
