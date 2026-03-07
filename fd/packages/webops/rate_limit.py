"""Per-tool rate limiter — ensures provider calls stay within RPM budget.

Each provider client holds its own RateLimiter instance configured from
config/tool_access.yaml.  Calling ``wait()`` before every HTTP request
guarantees we never exceed the declared RPM ceiling.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class RateLimiter:
    """Simple token-bucket-ish limiter keyed on requests-per-minute."""

    rpm: int
    _last: float = field(default=0.0, repr=False)

    def wait(self) -> None:
        if self.rpm <= 0:
            return
        min_interval = 60.0 / float(self.rpm)
        now = time.time()
        delta = now - self._last
        if delta < min_interval:
            time.sleep(min_interval - delta)
        self._last = time.time()
