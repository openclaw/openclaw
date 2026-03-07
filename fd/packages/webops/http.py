"""Shared HTTP retry helper for WebOps provider calls.

Retries with exponential back-off + jitter, matching the project convention
of 4 attempts with increasing delays.
"""
from __future__ import annotations

import random
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def with_retries(
    fn: Callable[[], T],
    *,
    tries: int = 4,
    base_sleep: float = 0.6,
) -> T:
    """Call *fn* up to *tries* times with exponential back-off.

    Raises the last exception if all attempts fail.
    """
    last: Exception | None = None
    for i in range(tries):
        try:
            return fn()
        except Exception as exc:
            last = exc
            sleep = base_sleep * (2 ** i) + random.random() * 0.25
            time.sleep(sleep)
    raise last  # type: ignore[misc]
