from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.ids import new_id
from packages.domain.deliverables_checklist import ensure_deliverables_checklist
from packages.domain.trello_cards import upsert_marked_block
from packages.integrations.trello.client import TrelloClient
from services.webhook_gateway.ops_security import require_admin_ops_token

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)

BEGIN = settings.MARKER_BEGIN_DELIVERY_LINKS
END = settings.MARKER_END_DELIVERY_LINKS


class PostDeliveryLinksRequest(BaseModel):
    card_id: str
    draft_links: list[str] = []
    final_links: list[str] = []
    deliverables: list[str] = []
    correlation_id: str | None = None


@router.post("/post_delivery_links")
def post_delivery_links(
    req: PostDeliveryLinksRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    cid = req.correlation_id or new_id("corr")

    payload = {
        "type": "delivery_links",
        "draft": req.draft_links,
        "final": req.final_links,
        "correlation_id": cid,
    }

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            _conn,
            action="admin.delivery.simulated",
            target=req.card_id,
            payload={"draft": len(req.draft_links), "final": len(req.final_links)},
            correlation_id=cid,
        )
        return {"ok": True, "mode": "dry_run", "correlation_id": cid}

    # Canonical replace-between-markers for delivery links block
    upsert_marked_block(
        _conn,
        card_id=req.card_id,
        begin_marker=BEGIN,
        end_marker=END,
        block_body=json.dumps(payload, separators=(",", ":")),
        correlation_id=cid,
    )

    # Ensure deliverables checklist
    if req.deliverables:
        ensure_deliverables_checklist(
            _conn,
            card_id=req.card_id,
            deliverables=req.deliverables,
            correlation_id=cid,
        )

    # Professional comment with JSON snippet
    tc = TrelloClient()
    comment = (
        "Delivery update.\n\n"
        f"Draft links: {len(req.draft_links)}\n"
        f"Final links: {len(req.final_links)}\n\n"
        "JSON:\n"
        + json.dumps(
            {
                "event": "delivery_update",
                "draft": req.draft_links,
                "final": req.final_links,
                "correlation_id": cid,
            },
            separators=(",", ":"),
        )
    )
    tc.add_comment(card_id=req.card_id, text=comment)

    write_audit(
        _conn,
        action="admin.delivery.applied",
        target=req.card_id,
        payload={"draft": len(req.draft_links), "final": len(req.final_links)},
        correlation_id=cid,
    )
    return {"ok": True, "mode": "live", "correlation_id": cid}
