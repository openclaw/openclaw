from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4


def build_audit_entry(action: str, memory_id: str, source_host: str) -> dict:
    return {
        "audit_id": str(uuid4()),
        "action": action,
        "memory_id": memory_id,
        "source_host": source_host,
        "ts": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
