from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.dropbox_autoinsert import sync_dropbox_link_to_reference_card
from packages.domain.ghl_contact_index import upsert_contact_index
from packages.domain.trello_lists import CanonicalClientLists, ensure_client_board_schema
from packages.domain.trello_reference_cards import create_reference_cards
from packages.domain.trello_webhooks import create_board_webhook
from packages.domain.welcome_instructions import apply_start_here_and_welcome
from packages.integrations.ghl.client import GHLClient
from packages.integrations.trello.client import TrelloClient

LIFECYCLE_CARD_NAME = "Account / Lifecycle"


def provision_client_board(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str,
    client_display_name: str,
    email: str | None,
    phone: str | None,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Provision a new Trello client board end-to-end.

    Creates board → canonical lists → lifecycle card → webhook →
    persists board_id into GHL custom field → updates local index.
    """
    board_name = client_display_name.strip() or f"Client {ghl_contact_id}"

    if settings.DRY_RUN or settings.SAFE_MODE:
        trello_board_id = f"dry_board_{ghl_contact_id}"
        lifecycle_card_id = f"dry_card_{ghl_contact_id}"
        webhook = create_board_webhook(
            conn,
            trello_board_id=trello_board_id,
            ghl_contact_id=ghl_contact_id,
            correlation_id=correlation_id,
        )
        upsert_contact_index(
            conn,
            ghl_contact_id=ghl_contact_id,
            email=email,
            phone=phone,
            trello_board_id=trello_board_id,
            trello_webhook_id=webhook["webhook_id"],
        )
        # Reference cards (dry-run passthrough)
        create_reference_cards(
            conn,
            trello_board_id=trello_board_id,
            correlation_id=correlation_id,
        )
        # Dropbox auto-insert (best effort)
        sync_dropbox_link_to_reference_card(
            conn,
            board_id=trello_board_id,
            ghl_contact_id=ghl_contact_id,
            client_name=client_display_name,
            correlation_id=correlation_id,
        )
        # Welcome + START HERE pinned (top card)
        apply_start_here_and_welcome(
            conn,
            board_id=trello_board_id,
            lifecycle_card_id=lifecycle_card_id,
            client_name=client_display_name,
            ghl_contact_id=ghl_contact_id,
            correlation_id=correlation_id,
        )
        write_audit(
            conn,
            action="trello.board.provision.simulated",
            target=ghl_contact_id,
            payload={"board_id": trello_board_id},
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "mode": "dry_run",
            "trello_board_id": trello_board_id,
            "lifecycle_card_id": lifecycle_card_id,
            "webhook_id": webhook["webhook_id"],
        }

    tc = TrelloClient()
    created_board = tc.create_board(
        name=board_name,
        org_id=settings.TRELLO_CLIENT_BOARD_ORG_ID,
        visibility=settings.TRELLO_CLIENT_BOARD_VISIBILITY,
    )
    trello_board_id = created_board["id"]

    # Ensure canonical lists on client board
    mapping = ensure_client_board_schema(trello_board_id, tc)
    inbox_list_id = mapping[CanonicalClientLists().requests]

    # Create lifecycle card (used for GHL↔Trello stage sync)
    lifecycle_desc = (
        "This card represents the client lifecycle stage.\n"
        "Do not use it for requests.\n\n"
        "JSON:\n"
        f'{{"type":"lifecycle","ghl_contact_id":"{ghl_contact_id}"}}'
    )
    lifecycle_card = tc.create_card(list_id=inbox_list_id, name=LIFECYCLE_CARD_NAME, desc=lifecycle_desc)
    lifecycle_card_id = lifecycle_card["id"]

    # Webhook for this board
    wh = create_board_webhook(
        conn,
        trello_board_id=trello_board_id,
        ghl_contact_id=ghl_contact_id,
        correlation_id=correlation_id,
    )
    webhook_id = wh["webhook_id"]

    # Persist lifecycle card id in board links
    ts = now_ts()
    conn.execute(
        "UPDATE trello_board_links SET lifecycle_card_id=?, updated_ts=? WHERE trello_board_id=?",
        (lifecycle_card_id, ts, trello_board_id),
    )
    conn.commit()

    # Seed reference cards on the board
    create_reference_cards(
        conn,
        trello_board_id=trello_board_id,
        tc=tc,
        correlation_id=correlation_id,
    )

    # Dropbox auto-insert (best effort)
    sync_dropbox_link_to_reference_card(
        conn,
        board_id=trello_board_id,
        ghl_contact_id=ghl_contact_id,
        client_name=client_display_name,
        correlation_id=correlation_id,
    )

    # Welcome + START HERE pinned (top card)
    apply_start_here_and_welcome(
        conn,
        board_id=trello_board_id,
        lifecycle_card_id=lifecycle_card_id,
        client_name=client_display_name,
        ghl_contact_id=ghl_contact_id,
        correlation_id=correlation_id,
    )

    # Update GHL custom field with board_id
    if settings.GHL_API_KEY and settings.GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY:
        gh = GHLClient()
        custom_fields: dict[str, str] = {
            settings.GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY: trello_board_id,
        }
        if settings.GHL_TRELLO_WEBHOOK_ID_CUSTOM_FIELD_KEY:
            custom_fields[settings.GHL_TRELLO_WEBHOOK_ID_CUSTOM_FIELD_KEY] = webhook_id
        gh.update_contact_custom_fields(
            contact_id=ghl_contact_id,
            custom_fields=custom_fields,
        )

    # Update local index
    upsert_contact_index(
        conn,
        ghl_contact_id=ghl_contact_id,
        email=email,
        phone=phone,
        trello_board_id=trello_board_id,
        trello_webhook_id=webhook_id,
    )

    write_audit(
        conn,
        action="trello.board.provision",
        target=ghl_contact_id,
        payload={"trello_board_id": trello_board_id, "webhook_id": webhook_id},
        correlation_id=correlation_id,
    )
    return {
        "ok": True,
        "mode": "live",
        "trello_board_id": trello_board_id,
        "lifecycle_card_id": lifecycle_card_id,
        "webhook_id": webhook_id,
    }
