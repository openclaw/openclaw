from __future__ import annotations

import threading
import time
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.client")


class NotionRateLimiter:
    """Token-bucket rate limiter for Notion API (3 req/s default)."""

    def __init__(self, rate: float = 3.0) -> None:
        self._rate = rate
        self._tokens = rate
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last
            self._tokens = min(self._rate, self._tokens + elapsed * self._rate)
            self._last = now
            if self._tokens < 1.0:
                wait = (1.0 - self._tokens) / self._rate
                time.sleep(wait)
                self._tokens = 0.0
            else:
                self._tokens -= 1.0


class NotionClient:
    """Thin Notion API wrapper with retry + token-bucket rate limiting."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://api.notion.com/v1",
        notion_version: str = "2022-06-28",
        rate_limit: float = 3.0,
    ) -> None:
        self.api_key = api_key or getattr(settings, "NOTION_API_KEY", "")
        self.base_url = base_url
        self.notion_version = notion_version
        self._client = httpx.Client(timeout=20.0)
        self._limiter = NotionRateLimiter(rate=rate_limit)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Notion-Version": self.notion_version,
            "Content-Type": "application/json",
        }

    @retry(
        reraise=True,
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def create_page(self, parent_db_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        self._limiter.acquire()
        resp = self._client.post(
            f"{self.base_url}/pages",
            json={"parent": {"database_id": parent_db_id}, "properties": properties},
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    @retry(
        reraise=True,
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def update_page(self, page_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        self._limiter.acquire()
        resp = self._client.patch(
            f"{self.base_url}/pages/{page_id}",
            json={"properties": properties},
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    @retry(
        reraise=True,
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def query_db(self, db_id: str, filter_: dict[str, Any] | None = None) -> dict[str, Any]:
        self._limiter.acquire()
        payload: dict[str, Any] = {}
        if filter_:
            payload["filter"] = filter_
        resp = self._client.post(
            f"{self.base_url}/databases/{db_id}/query",
            json=payload,
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    @retry(
        reraise=True,
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=1, max=10),
        retry=retry_if_exception_type(httpx.HTTPError),
    )
    def create_database(
        self, parent_page_id: str, title: str, properties: dict[str, Any]
    ) -> dict[str, Any]:
        self._limiter.acquire()
        resp = self._client.post(
            f"{self.base_url}/databases",
            json={
                "parent": {"type": "page_id", "page_id": parent_page_id},
                "title": [{"type": "text", "text": {"content": title}}],
                "properties": properties,
            },
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()
