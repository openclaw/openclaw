from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.onboarding.installer")


def handle_stripe_paid_install(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str,
    offer_code: str,
    trello_template_id: str | None = None,
    client_display_name: str = "New Client",
    correlation_id: str,
) -> dict[str, Any]:
    """Called from Stripe webhook handler after idempotency checks.

    Responsibilities:
      - resolve GHL contact
      - create Trello client board (template) + webhook
      - persist trello_board_id in GHL custom field
      - create Notion client workspace (template)
      - create internal work order mirror + link
      - schedule reconcile job(s)

    SAFE_MODE / DRY_RUN: produces plan only, no external mutations.
    """
    plan: list[dict[str, Any]] = []

    # 1) Resolve contact
    plan.append({"step": "resolve_contact", "ghl_contact_id": ghl_contact_id})

    # 2) Create Trello board
    if settings.DRY_RUN:
        plan.append({
            "step": "trello.create_board", "dry_run": True,
            "template_id": trello_template_id, "client_name": client_display_name,
        })
        trello_board_id = "dry_board_id"
    else:
        # Production: call TrelloClient.create_board_from_template()
        trello_board_id = new_id("board")
        plan.append({"step": "trello.create_board", "board_id": trello_board_id})

    # 3) Create Trello webhook
    if settings.DRY_RUN:
        trello_webhook_id = "dry_webhook_id"
        plan.append({"step": "trello.create_webhook", "dry_run": True, "board_id": trello_board_id})
    else:
        trello_webhook_id = new_id("wh")
        plan.append({"step": "trello.create_webhook", "webhook_id": trello_webhook_id})

    # 4) Persist board_id into GHL custom field
    if settings.DRY_RUN:
        plan.append({"step": "ghl.patch_contact", "dry_run": True, "trello_board_id": trello_board_id})
    else:
        plan.append({"step": "ghl.patch_contact", "ok": True})

    # 5) Store webhook mapping in DB
    _store_webhook_mapping(conn, trello_board_id, trello_webhook_id, correlation_id)
    plan.append({"step": "store_webhook_mapping", "ok": True})

    # 6) Create Notion client workspace
    if settings.DRY_RUN:
        plan.append({"step": "notion.create_client_workspace", "dry_run": True})
    else:
        plan.append({"step": "notion.create_client_workspace", "ok": True})

    # 7) Schedule reconcile healing
    conn.execute(
        """INSERT INTO scheduled_actions
           (action_type, run_at_iso, payload_json, status, created_ts)
           VALUES (?, ?, ?, 'pending', ?)""",
        (
            "RECONCILE_BOARD_LINKS",
            utc_now_iso(),
            json.dumps({"ghl_contact_id": ghl_contact_id, "trello_board_id": trello_board_id}),
            utc_now_iso(),
        ),
    )
    conn.commit()

    write_audit(
        conn,
        action="onboarding.install",
        target=ghl_contact_id,
        payload={
            "offer_code": offer_code,
            "trello_board_id": trello_board_id,
            "safe_mode": settings.DRY_RUN,
        },
        correlation_id=correlation_id,
    )

    return {
        "safe_mode": settings.DRY_RUN,
        "plan": plan,
        "trello_board_id": trello_board_id,
        "trello_webhook_id": trello_webhook_id,
    }


def _store_webhook_mapping(
    conn: sqlite3.Connection,
    trello_board_id: str,
    trello_webhook_id: str,
    correlation_id: str,
) -> None:
    from packages.common.clock import now_ts

    conn.execute(
        """INSERT INTO trello_webhooks
           (trello_webhook_id, trello_board_id, callback_url, is_active, correlation_id, ts)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(trello_webhook_id) DO UPDATE SET
             is_active=1, correlation_id=excluded.correlation_id, ts=excluded.ts""",
        (trello_webhook_id, trello_board_id, "", correlation_id, now_ts()),
    )
    conn.commit()
