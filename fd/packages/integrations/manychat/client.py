from __future__ import annotations

from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from packages.common.config import settings


class ManyChatClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key or settings.MANYCHAT_API_KEY
        self.base_url = base_url or settings.MANYCHAT_BASE_URL
        self._client = httpx.Client(timeout=20.0)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def send_text(self, subscriber_id: str, text: str) -> dict[str, Any]:
        # ManyChat endpoint may differ; this is the canonical "request shaping" stub.
        url = f"{self.base_url}/fb/sending/sendContent"
        payload = {"subscriber_id": subscriber_id, "message": {"text": text}}
        resp = self._client.post(url, headers=self._headers(), json=payload)
        resp.raise_for_status()
        return resp.json()
