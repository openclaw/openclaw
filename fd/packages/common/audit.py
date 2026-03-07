from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from packages.common.ids import new_id


def write_audit(
    conn: sqlite3.Connection,
    *,
    action: str,
    target: str,
    payload: dict[str, Any],
    correlation_id: str | None = None,
) -> str:
    audit_id = new_id("audit")
    conn.execute(
        "INSERT INTO audit_log (id, ts, action, target, correlation_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
        (
            audit_id,
            int(time.time()),
            action,
            target,
            correlation_id,
            json.dumps(payload, ensure_ascii=False),
        ),
    )
    conn.commit()
    return audit_id
