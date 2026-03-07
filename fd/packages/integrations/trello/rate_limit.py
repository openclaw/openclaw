"""Rate-limit-aware retry for Trello API calls.

Handles:
- 429 (rate limited): respects Retry-After header, falls back to exponential backoff
- 5xx (transient server errors): exponential backoff with jitter
- Network timeouts / connection errors: exponential backoff with jitter

Designed for httpx + tenacity (already used by TrelloClient).
"""
from __future__ import annotations

import time

import httpx
from tenacity import RetryCallState


class TrelloRateLimitError(httpx.HTTPStatusError):
    """Raised when Trello returns 429 so tenacity retries it."""

    def __init__(self, response: httpx.Response) -> None:
        self.retry_after = _parse_retry_after(response)
        super().__init__(
            f"Trello 429 rate limited (retry_after={self.retry_after}s)",
            request=response.request,
            response=response,
        )


class TrelloServerError(httpx.HTTPStatusError):
    """Raised on 5xx so tenacity retries it."""

    def __init__(self, response: httpx.Response) -> None:
        super().__init__(
            f"Trello {response.status_code} server error",
            request=response.request,
            response=response,
        )


def _parse_retry_after(response: httpx.Response) -> float:
    """Parse Retry-After header, defaulting to 10s."""
    raw = response.headers.get("retry-after", "")
    try:
        return min(float(raw), 30.0)
    except (ValueError, TypeError):
        return 10.0


def raise_for_status_rate_limit(response: httpx.Response) -> None:
    """Like response.raise_for_status() but raises retryable errors for 429/5xx."""
    if response.status_code == 429:
        raise TrelloRateLimitError(response)
    if 500 <= response.status_code < 600:
        raise TrelloServerError(response)
    response.raise_for_status()


def wait_with_retry_after(retry_state: RetryCallState) -> float:
    """Tenacity wait callback: use Retry-After for 429, else exponential backoff."""
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    if isinstance(exc, TrelloRateLimitError) and exc.retry_after > 0:
        return exc.retry_after
    # Exponential backoff with jitter: 1s, 2s, 4s, 8s... capped at 20s
    attempt = retry_state.attempt_number
    import random

    base = min(1.0 * (2 ** (attempt - 1)), 20.0)
    return base * (0.7 + random.random() * 0.6)


def sleep_for_retry_after(response: httpx.Response) -> None:
    """If response is 429 with Retry-After, sleep that duration. For manual use."""
    if response.status_code == 429:
        delay = _parse_retry_after(response)
        time.sleep(delay)
