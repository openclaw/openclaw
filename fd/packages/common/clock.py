from __future__ import annotations

import time
from datetime import UTC, datetime


def now_ts() -> int:
    return int(time.time())


def utc_now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()
