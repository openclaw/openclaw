from __future__ import annotations

import time
from collections import defaultdict

from packages.common.logging import get_logger

log = get_logger("agencyu.notion.rate_limit")


class RateLimiter:
    """Per-resource rate limiter for Notion API calls.

    Tracks last-call timestamps per resource key and enforces minimum intervals.
    Thread-safe via GIL for single-threaded async use; for multi-threaded use,
    wrap in a lock.
    """

    def __init__(self, default_interval_s: float = 0.35) -> None:
        self.default_interval_s = default_interval_s
        self._last_call: dict[str, float] = defaultdict(float)
        self._total_waits: int = 0

    def wait(self, resource_key: str, min_interval_s: float | None = None) -> None:
        """Block until the minimum interval has elapsed for this resource."""
        interval = min_interval_s or self.default_interval_s
        now = time.monotonic()
        last = self._last_call[resource_key]
        elapsed = now - last

        if elapsed < interval:
            sleep_time = interval - elapsed
            self._total_waits += 1
            time.sleep(sleep_time)

        self._last_call[resource_key] = time.monotonic()

    def reset(self, resource_key: str | None = None) -> None:
        """Reset rate limit tracking."""
        if resource_key:
            self._last_call.pop(resource_key, None)
        else:
            self._last_call.clear()
            self._total_waits = 0

    @property
    def stats(self) -> dict[str, int]:
        return {
            "tracked_resources": len(self._last_call),
            "total_waits": self._total_waits,
        }
