from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError
from packages.common.ids import new_id
from packages.domain.lifecycle_cleanup import run_cleanup
from packages.integrations.stripe.client import StripeClient
from services.webhook_gateway.ops_security import require_admin_ops_token

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


OfferKey = Literal["fd_rollout_800", "fd_sub_1500", "cutmv_pro"]


class CreateCheckoutLinkRequest(BaseModel):
    brand: Literal["fulldigital", "cutmv"] = "fulldigital"
    offer_key: OfferKey
    customer_email: str
    ghl_contact_id: str | None = None
    correlation_id: str | None = None


class CreateCheckoutLinkResponse(BaseModel):
    ok: bool
    correlation_id: str
    offer_key: OfferKey
    mode: str
    checkout_url: str


def _price_for_offer(offer_key: OfferKey) -> str:
    mapping = {
        "fd_rollout_800": settings.STRIPE_PRICE_ID_FD_ROLLOUT_800,
        "fd_sub_1500": settings.STRIPE_PRICE_ID_FD_SUB_1500,
        "cutmv_pro": settings.STRIPE_PRICE_ID_CUTMV_PRO,
    }
    price_id = mapping.get(offer_key, "")
    if not price_id:
        raise ValueError(f"Missing Stripe price id for offer_key={offer_key}")
    return price_id


@router.post("/create_checkout_link", response_model=CreateCheckoutLinkResponse)
def create_checkout_link(req: CreateCheckoutLinkRequest, _: None = Depends(require_admin_ops_token)) -> Any:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    correlation_id = req.correlation_id or new_id("corr")
    price_id = _price_for_offer(req.offer_key)

    metadata: dict[str, str] = {
        "brand": req.brand,
        "offer_key": req.offer_key,
        "correlation_id": correlation_id,
    }
    if req.ghl_contact_id:
        metadata["ghl_contact_id"] = req.ghl_contact_id

    # DRY_RUN: log intent + return simulated link (never touches Stripe)
    if settings.DRY_RUN:
        write_audit(
            _conn,
            action="stripe.create_checkout_session(dry_run)",
            target="stripe",
            payload={
                "price_id": price_id,
                "customer_email": req.customer_email,
                "success_url": settings.CHECKOUT_SUCCESS_URL,
                "cancel_url": settings.CHECKOUT_CANCEL_URL,
                "metadata": metadata,
            },
            correlation_id=correlation_id,
        )
        return CreateCheckoutLinkResponse(
            ok=True,
            correlation_id=correlation_id,
            offer_key=req.offer_key,
            mode="dry_run",
            checkout_url=f"https://checkout.stripe.com/pay/dry_run_{correlation_id}",
        )

    # Real mode: create Stripe checkout session
    sc = StripeClient()
    session = sc.create_checkout_session(
        price_id=price_id,
        customer_email=req.customer_email,
        success_url=settings.CHECKOUT_SUCCESS_URL,
        cancel_url=settings.CHECKOUT_CANCEL_URL,
        metadata=metadata,
    )

    write_audit(
        _conn,
        action="stripe.create_checkout_session",
        target="stripe",
        payload={"session_id": session.get("id"), "url": session.get("url"), "metadata": metadata},
        correlation_id=correlation_id,
    )

    return CreateCheckoutLinkResponse(
        ok=True,
        correlation_id=correlation_id,
        offer_key=req.offer_key,
        mode="live",
        checkout_url=str(session.get("url")),
    )


class TrelloWebhookCleanupRequest(BaseModel):
    trello_board_id: str


@router.post("/trello_webhook_cleanup")
def trello_webhook_cleanup(req: TrelloWebhookCleanupRequest, _: None = Depends(require_admin_ops_token)) -> dict:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    result = run_cleanup(
        _conn,
        source="ops",
        source_event_id=f"ops_cleanup:{req.trello_board_id}",
        trello_board_id=req.trello_board_id,
        correlation_id=None,
        reason="ops_manual_cleanup",
        offer_key=None,
    )
    return {"ok": True, "status": "cleanup_triggered", "cleanup": result}
