from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from packages.agencyu.attribution.engine import AttributionEngine
from packages.agencyu.clickfunnels.webhook import (
    normalize_clickfunnels_event,
    store_clickfunnels_event,
)
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.idempotency import seen_or_mark
from packages.common.ids import new_id
from packages.common.logging import get_logger
from services.webhook_gateway.security import require_webhook_secret

log = get_logger("webhook.clickfunnels")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.post("")
async def clickfunnels_webhook(
    request: Request,
    _: None = Depends(require_webhook_secret),
) -> dict[str, Any]:
    """Receive ClickFunnels form/application webhooks."""
    body = await request.json()
    correlation_id = new_id("cf")

    # Idempotency check
    idem_key = f"cf:{body.get('id', correlation_id)}"
    if seen_or_mark(_conn, idem_key):
        return {"ok": True, "duplicate": True}

    # Normalize
    event = normalize_clickfunnels_event(body)

    # Store
    event_id = store_clickfunnels_event(_conn, event, correlation_id=correlation_id)

    # Record attribution if we have a contact key
    attr_result = None
    if event.email or body.get("ghl_contact_id"):
        engine = AttributionEngine(_conn)
        update = engine.extract_from_payload({
            "email": event.email,
            "ghl_contact_id": body.get("ghl_contact_id"),
            "utm_source": event.utm_source,
            "utm_medium": event.utm_medium,
            "utm_campaign": event.utm_campaign,
            "utm_content": event.utm_content,
        })
        if update:
            attr_result = engine.record_snapshot(update)

    log.info("clickfunnels_event_processed", extra={
        "event_id": event_id,
        "event_type": event.event_type,
        "email": event.email,
        "correlation_id": correlation_id,
    })

    return {
        "ok": True,
        "event_id": event_id,
        "event_type": event.event_type,
        "attribution_snapshot_id": attr_result,
    }
