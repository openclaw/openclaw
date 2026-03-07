from __future__ import annotations

import secrets
import time


def new_id(prefix: str) -> str:
    # sortable-ish, collision-resistant enough for internal use
    return f"{prefix}_{int(time.time())}_{secrets.token_hex(6)}"
