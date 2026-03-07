from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.agencyu.campaigns.authority import (
    attach_lead_to_campaign,
    create_authority_campaign,
    get_campaign_report,
)
from packages.agencyu.campaigns.momentum import (
    create_momentum_campaign,
    stop_momentum_campaign,
)
from packages.agencyu.setter_os.metrics import (
    get_setter_daily_metrics,
    upsert_setter_daily_metrics,
)
from packages.agencyu.setter_os.touches import log_lead_touch
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("agencyu.admin")
router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


# ── Campaign endpoints ──


class CreateCampaignBody(BaseModel):
    utm_campaign: str
    notes: str | None = None


@router.post("/campaigns/authority")
def admin_create_authority(
    body: CreateCampaignBody,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    cid = create_authority_campaign(_conn, utm_campaign=body.utm_campaign, notes=body.notes)
    return {"ok": True, "campaign_id": cid}


@router.post("/campaigns/momentum")
def admin_create_momentum(
    body: CreateCampaignBody,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    cid = create_momentum_campaign(_conn, utm_campaign=body.utm_campaign, notes=body.notes)
    return {"ok": True, "campaign_id": cid}


@router.post("/campaigns/{campaign_id}/stop")
def admin_stop_momentum(
    campaign_id: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    return stop_momentum_campaign(_conn, campaign_id=campaign_id)


@router.get("/campaigns/{campaign_id}/report")
def admin_campaign_report(
    campaign_id: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    return get_campaign_report(_conn, campaign_id=campaign_id)


class AttachLeadBody(BaseModel):
    lead_id: str
    ghl_contact_id: str | None = None
    manychat_contact_id: str | None = None


@router.post("/campaigns/{campaign_id}/attach")
def admin_attach_lead(
    campaign_id: str,
    body: AttachLeadBody,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    cc_id = attach_lead_to_campaign(
        _conn,
        campaign_id=campaign_id,
        lead_id=body.lead_id,
        ghl_contact_id=body.ghl_contact_id,
        manychat_contact_id=body.manychat_contact_id,
    )
    return {"ok": True, "campaign_contact_id": cc_id}


# ── Setter OS endpoints ──


class SetterEodBody(BaseModel):
    date: str
    setter_id: str
    metrics: dict[str, Any] = {}


@router.post("/setter/eod")
def admin_setter_eod(
    body: SetterEodBody,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    row_id = upsert_setter_daily_metrics(
        _conn,
        date=body.date,
        setter_id=body.setter_id,
        metrics=body.metrics,
    )
    return {"ok": True, "row_id": row_id}


@router.get("/setter/{setter_id}/metrics/{date}")
def admin_get_setter_metrics(
    setter_id: str,
    date: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    result = get_setter_daily_metrics(_conn, setter_id=setter_id, date=date)
    if not result:
        return {"ok": False, "error": "no_metrics_found"}
    return {"ok": True, **result}


class LogTouchBody(BaseModel):
    lead_id: str
    channel: str
    action: str
    outcome: str | None = None
    note: str | None = None


@router.post("/setter/touch")
def admin_log_touch(
    body: LogTouchBody,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    from packages.common.ids import new_id

    tid = log_lead_touch(
        _conn,
        lead_id=body.lead_id,
        channel=body.channel,
        action=body.action,
        outcome=body.outcome,
        note=body.note,
        correlation_id=new_id("corr"),
    )
    return {"ok": True, "touch_id": tid}
