from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.ghl_custom_fields import get_dropbox_folder_url
from packages.domain.trello_cards import find_card_in_list_by_name, upsert_marked_block
from packages.domain.trello_lists import CanonicalClientLists, ensure_client_board_schema
from packages.integrations.trello.client import TrelloClient

DROPBOX_BEGIN = "BEGIN_DROPBOX_LINK"
DROPBOX_END = "END_DROPBOX_LINK"


def _render_dropbox_body(url: str) -> str:
    return (
        "Dropbox folder link\n"
        f"URL: {url}\n"
        "Note: Synced from GHL. Update the value in GHL to change it here."
    )


def sync_dropbox_link_to_reference_card(
    conn: sqlite3.Connection,
    *,
    board_id: str,
    ghl_contact_id: str,
    client_name: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Hardened Dropbox auto-insert.

    If Dropbox reference card is missing, creates it in Reference & Links
    list then populates it. DRY_RUN/SAFE_MODE: no Trello mutations,
    only reports would_* actions. Idempotent via marker-based upsert.
    """
    url = get_dropbox_folder_url(
        conn, ghl_contact_id=ghl_contact_id, correlation_id=correlation_id
    )
    if not url:
        write_audit(
            conn,
            action="dropbox_autoinsert.skipped",
            target=board_id,
            payload={"reason": "no_dropbox_url"},
            correlation_id=correlation_id,
        )
        return {"ok": True, "skipped": True, "reason": "no_dropbox_url"}

    tc = TrelloClient()

    # Ensure schema so Reference & Links list exists
    mapping = ensure_client_board_schema(board_id, tc)
    ref_list_id = mapping[CanonicalClientLists().reference]

    dropbox_name = (
        settings.TRELLO_REFERENCE_CARD_DROPBOX_NAME
        or "Dropbox folder (assets + deliverables)"
    )
    card = find_card_in_list_by_name(tc, list_id=ref_list_id, name=dropbox_name)

    body = _render_dropbox_body(url)

    # If missing, create card (hardened)
    if not card:
        if settings.DRY_RUN or settings.SAFE_MODE:
            write_audit(
                conn,
                action="dropbox_autoinsert.would_create_card",
                target=board_id,
                payload={
                    "card_name": dropbox_name,
                    "list_id": ref_list_id,
                    "url": url,
                },
                correlation_id=correlation_id,
            )
            return {
                "ok": True,
                "mode": "dry_run",
                "created_card": True,
                "card_name": dropbox_name,
                "url": url,
            }

        created = tc.create_card(
            list_id=ref_list_id,
            name=dropbox_name,
            desc=(
                f"Client: {client_name}\n\n"
                "Paste the shared Dropbox folder link here.\n\n"
                "Suggested structure:\n"
                "/Assets\n"
                "/Exports\n"
                "/References\n"
                "/Final\n"
            ),
        )
        card = created
        write_audit(
            conn,
            action="dropbox_autoinsert.card_created",
            target=created["id"],
            payload={"board_id": board_id, "card_name": dropbox_name},
            correlation_id=correlation_id,
        )

    # Replace canonical block between markers (idempotent)
    upsert_marked_block(
        conn,
        card_id=card["id"],
        begin_marker=DROPBOX_BEGIN,
        end_marker=DROPBOX_END,
        block_body=body,
        correlation_id=correlation_id,
    )

    write_audit(
        conn,
        action="dropbox_autoinsert.applied",
        target=card["id"],
        payload={"url": url, "card_name": dropbox_name},
        correlation_id=correlation_id,
    )
    return {
        "ok": True,
        "applied": True,
        "card_id": card["id"],
        "url": url,
        "card_name": dropbox_name,
    }
