from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.clickfunnels.webhook")

# Known ClickFunnels event types
CF_FORM_SUBMITTED = "clickfunnels.form_submitted"
CF_APPLICATION_SUBMITTED = "clickfunnels.application_submitted"


@dataclass
class ClickFunnelsEvent:
    """Normalized ClickFunnels webhook event."""
    event_type: str
    email: str | None = None
    name: str | None = None
    phone: str | None = None
    funnel_id: str | None = None
    page_id: str | None = None
    utm_source: str | None = None
    utm_medium: str | None = None
    utm_campaign: str | None = None
    utm_content: str | None = None
    application_answers: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)


def normalize_clickfunnels_event(payload: dict[str, Any]) -> ClickFunnelsEvent:
    """Normalize a raw ClickFunnels webhook payload into a structured event.

    Handles both form_submitted and application_submitted payloads.
    ClickFunnels sends different shapes depending on the page type.
    """
    # Determine event type
    event_type = payload.get("event", "")
    if not event_type:
        # Infer from payload structure
        if payload.get("application_answers") or payload.get("answers"):
            event_type = CF_APPLICATION_SUBMITTED
        else:
            event_type = CF_FORM_SUBMITTED

    # Extract contact info
    contact = payload.get("contact", {}) or {}
    email = contact.get("email") or payload.get("email")
    name = contact.get("name") or payload.get("name")
    phone = contact.get("phone") or payload.get("phone")

    # Extract funnel context
    funnel_id = payload.get("funnel_id") or payload.get("funnel", {}).get("id")
    page_id = payload.get("page_id") or payload.get("page", {}).get("id")

    # Extract UTMs
    utm_source = payload.get("utm_source")
    utm_medium = payload.get("utm_medium")
    utm_campaign = payload.get("utm_campaign")
    utm_content = payload.get("utm_content")

    # Fall back to nested UTM block
    utms = payload.get("utm", {}) or {}
    if not utm_source:
        utm_source = utms.get("source")
    if not utm_medium:
        utm_medium = utms.get("medium")
    if not utm_campaign:
        utm_campaign = utms.get("campaign")
    if not utm_content:
        utm_content = utms.get("content")

    # Extract application answers
    application_answers: dict[str, Any] = {}
    if event_type == CF_APPLICATION_SUBMITTED:
        application_answers = (
            payload.get("application_answers")
            or payload.get("answers")
            or {}
        )

    return ClickFunnelsEvent(
        event_type=event_type,
        email=email,
        name=name,
        phone=phone,
        funnel_id=str(funnel_id) if funnel_id else None,
        page_id=str(page_id) if page_id else None,
        utm_source=utm_source,
        utm_medium=utm_medium,
        utm_campaign=utm_campaign,
        utm_content=utm_content,
        application_answers=application_answers,
        raw_payload=payload,
    )


def store_clickfunnels_event(
    conn: sqlite3.Connection,
    event: ClickFunnelsEvent,
    *,
    correlation_id: str = "",
) -> str:
    """Persist a normalized CF event to clickfunnels_events table."""
    event_id = new_id("cfe")
    now = utc_now_iso()
    conn.execute(
        """INSERT INTO clickfunnels_events
           (id, event_type, funnel_id, page_id, email, name, phone,
            utm_source, utm_medium, utm_campaign, utm_content,
            payload_json, correlation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            event_id, event.event_type, event.funnel_id, event.page_id,
            event.email, event.name, event.phone,
            event.utm_source, event.utm_medium, event.utm_campaign, event.utm_content,
            json.dumps(event.raw_payload), correlation_id, now,
        ),
    )
    conn.commit()
    log.info("clickfunnels_event_stored", extra={
        "event_id": event_id,
        "event_type": event.event_type,
        "email": event.email,
    })
    return event_id
