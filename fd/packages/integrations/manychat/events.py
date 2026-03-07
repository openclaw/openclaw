from __future__ import annotations

from typing import Any

from packages.common.logging import get_logger

log = get_logger("manychat.events")

# Event types from ManyChat webhooks
EVENT_TYPES = {
    "subscriber_created",
    "tag_applied",
    "tag_removed",
    "custom_field_updated",
    "flow_completed",
}


def parse_webhook_event(payload: dict[str, Any]) -> dict[str, Any]:
    """Parse a ManyChat webhook event payload into a normalized structure.

    Returns normalized event dict with: event_type, subscriber_id, tags, fields, ts.
    """
    event_type = payload.get("event", payload.get("type", "unknown"))
    subscriber = payload.get("subscriber", {})
    subscriber_id = (
        subscriber.get("id")
        or payload.get("subscriber_id")
        or payload.get("psid")
    )

    tags = []
    raw_tags = subscriber.get("tags", payload.get("tags", []))
    if isinstance(raw_tags, list):
        for t in raw_tags:
            if isinstance(t, dict):
                tags.append(t.get("name", ""))
            elif isinstance(t, str):
                tags.append(t)

    custom_fields = subscriber.get("custom_fields", payload.get("custom_fields", {}))
    if isinstance(custom_fields, list):
        custom_fields = {f.get("name", ""): f.get("value") for f in custom_fields if isinstance(f, dict)}

    return {
        "event_type": event_type,
        "subscriber_id": subscriber_id,
        "tags": [t for t in tags if t],
        "custom_fields": custom_fields if isinstance(custom_fields, dict) else {},
        "email": subscriber.get("email") or custom_fields.get("email"),
        "phone": subscriber.get("phone") or custom_fields.get("phone"),
        "first_name": subscriber.get("first_name"),
        "last_name": subscriber.get("last_name"),
        "raw": payload,
    }


def is_valid_event(event: dict[str, Any]) -> bool:
    """Check if parsed event has minimum required data."""
    return bool(event.get("subscriber_id")) and event.get("event_type") != "unknown"
