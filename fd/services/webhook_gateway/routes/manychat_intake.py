from __future__ import annotations

from fastapi import APIRouter, Header
from pydantic import BaseModel

from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.errors import WebhookAuthError
from packages.common.logging import get_logger, log_info
from packages.domain.ghl_resolution import resolve_client_board_id
from packages.domain.internal_fulfillment import create_work_order

logger = get_logger("webhook.manychat_intake")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


class ManyChatIntakePayload(BaseModel):
    event_id: str
    ghl_contact_id: str | None = None
    ig_username: str | None = None
    message: str
    client_name: str | None = None


@router.post("")
def manychat_intake(
    payload: ManyChatIntakePayload,
    x_webhook_secret: str | None = Header(default=None),
) -> dict:
    if settings.MANYCHAT_INTAKE_WEBHOOK_SECRET:
        if x_webhook_secret != settings.MANYCHAT_INTAKE_WEBHOOK_SECRET:
            raise WebhookAuthError("Invalid ManyChat intake webhook secret")

    log_info(
        logger,
        "manychat intake received",
        extra={"event_id": payload.event_id, "ig_username": payload.ig_username},
    )

    if not payload.ghl_contact_id:
        return {"ok": False, "error": "missing_ghl_contact_id"}

    board_id = resolve_client_board_id(_conn, ghl_contact_id=payload.ghl_contact_id)
    if not board_id:
        return {"ok": False, "error": "could_not_resolve_client_board_id"}

    out = create_work_order(
        _conn,
        source="manychat",
        source_event_id=payload.event_id,
        ghl_contact_id=payload.ghl_contact_id,
        client_board_id=board_id,
        client_card_id=None,
        intake_text=payload.message,
        correlation_id=None,
        extra={"client_name": payload.client_name or payload.ig_username or "Client"},
    )
    return {"ok": True, "result": out}
