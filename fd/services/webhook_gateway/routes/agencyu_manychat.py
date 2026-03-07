from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from packages.agencyu.manychat.ingest import ingest_manychat_event
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.idempotency import seen_or_mark
from packages.common.ids import new_id
from packages.common.logging import get_logger
from services.webhook_gateway.security import require_webhook_secret

log = get_logger("agencyu.webhook.manychat")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.post("")
async def agencyu_manychat_webhook(
    request: Request,
    _: None = Depends(require_webhook_secret),
) -> dict[str, Any]:
    """Ingest ManyChat events into the AgencyU lead pipeline.

    Parses tags, upserts agencyu_leads, schedules resolve + mirror sync.
    """
    payload = await request.json()
    correlation_id = new_id("corr")

    # Idempotency
    event_id = payload.get("event_id") or payload.get("id") or new_id("evt")
    if seen_or_mark(_conn, key=f"agencyu_mc:{event_id}"):
        return {"ok": True, "duplicate": True, "correlation_id": correlation_id}

    result = ingest_manychat_event(
        _conn,
        payload,
        correlation_id=correlation_id,
    )

    return {"ok": True, "correlation_id": correlation_id, "event_id": event_id, **result}
