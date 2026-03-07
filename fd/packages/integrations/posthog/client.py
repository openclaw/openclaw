from __future__ import annotations

from typing import Any

import httpx

from packages.common.config import settings


class PostHogClient:
    def __init__(self) -> None:
        self.api_key = settings.POSTHOG_API_KEY
        self.host = settings.POSTHOG_HOST.rstrip("/")
        self._client = httpx.Client(timeout=10.0)

    def capture(self, distinct_id: str, event: str, properties: dict[str, Any] | None = None) -> None:
        if not self.api_key:
            return
        # IMPORTANT: no raw PII — caller should pass internal IDs only
        payload = {
            "api_key": self.api_key,
            "event": event,
            "distinct_id": distinct_id,
            "properties": properties or {},
        }
        try:
            self._client.post(f"{self.host}/capture/", json=payload)
        except Exception:
            return
