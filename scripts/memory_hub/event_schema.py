from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

ALLOWED_EVENT_TYPES = {
    "user_confirmed",
    "task_completed",
    "session_compacted",
    "session_ending",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_event(raw: dict) -> dict:
    event_type = raw["event_type"]
    if event_type not in ALLOWED_EVENT_TYPES:
        raise ValueError(f"unsupported event_type: {event_type}")
    return {
        "event_id": raw.get("event_id", str(uuid4())),
        "event_type": event_type,
        "source_host": raw["source_host"],
        "source_file": raw["source_file"],
        "payload": raw.get("payload", {}),
        "observed_at": raw.get("observed_at", now_iso()),
    }
