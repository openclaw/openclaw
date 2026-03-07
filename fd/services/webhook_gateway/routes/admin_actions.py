"""Admin quick-action endpoints (internal team "buttons").

POST /admin/actions/post_draft_link
POST /admin/actions/post_final_link
POST /admin/actions/request_client_review
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError
from packages.common.ids import new_id
from packages.domain.quick_actions import post_draft_link, post_final_link, request_client_review
from services.webhook_gateway.ops_security import require_admin_ops_token

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


class DraftLinkRequest(BaseModel):
    internal_card_id: str | None = None
    client_card_id: str | None = None
    url: str
    note: str | None = None
    correlation_id: str | None = None


class FinalLinkRequest(BaseModel):
    internal_card_id: str | None = None
    client_card_id: str | None = None
    url: str
    note: str | None = None
    correlation_id: str | None = None


class ReviewRequest(BaseModel):
    internal_card_id: str | None = None
    client_card_id: str | None = None
    message: str | None = None
    correlation_id: str | None = None


@router.post("/post_draft_link")
def api_post_draft_link(
    req: DraftLinkRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    cid = req.correlation_id or new_id("corr")
    result = post_draft_link(
        _conn,
        internal_card_id=req.internal_card_id,
        client_card_id=req.client_card_id,
        url=req.url,
        note=req.note,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}


@router.post("/post_final_link")
def api_post_final_link(
    req: FinalLinkRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    cid = req.correlation_id or new_id("corr")
    result = post_final_link(
        _conn,
        internal_card_id=req.internal_card_id,
        client_card_id=req.client_card_id,
        url=req.url,
        note=req.note,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}


@router.post("/request_client_review")
def api_request_client_review(
    req: ReviewRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    cid = req.correlation_id or new_id("corr")
    result = request_client_review(
        _conn,
        internal_card_id=req.internal_card_id,
        client_card_id=req.client_card_id,
        message=req.message,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}
