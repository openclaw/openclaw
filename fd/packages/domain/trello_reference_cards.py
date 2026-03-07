from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.logging import get_logger
from packages.domain.reference_templates import DEFAULT_REFERENCE_TEMPLATES, ReferenceTemplate
from packages.domain.trello_lists import CanonicalClientLists, resolve_list_id_by_name
from packages.integrations.trello.client import TrelloClient

log = get_logger("reference_cards")


def _existing_card_names(tc: TrelloClient, board_id: str) -> set[str]:
    """Fetch all card names on a board for idempotency checks."""
    try:
        cards = tc.get_board_cards(board_id=board_id)
        return {c.get("name", "") for c in cards}
    except Exception:
        log.warning("Could not fetch board cards for idempotency check, will attempt creation anyway")
        return set()


def create_reference_cards(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    tc: TrelloClient | None = None,
    templates: list[ReferenceTemplate] | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Create default reference cards on a client board's Reference & Links list.

    Idempotent: skips cards whose name already exists on the board.
    """
    templates = templates or DEFAULT_REFERENCE_TEMPLATES
    tc = tc or TrelloClient()

    if settings.DRY_RUN or settings.SAFE_MODE:
        card_names = [t.name for t in templates]
        write_audit(
            conn,
            action="trello.reference_cards.simulated",
            target=trello_board_id,
            payload={"cards": card_names},
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "mode": "dry_run",
            "board_id": trello_board_id,
            "cards_created": card_names,
        }

    # Resolve reference list
    lists = tc.get_lists(board_id=trello_board_id)
    ref_list_name = CanonicalClientLists().reference
    ref_list_id = resolve_list_id_by_name(lists, ref_list_name)
    if not ref_list_id:
        log.warning(f"Reference list '{ref_list_name}' not found on board {trello_board_id}, skipping")
        return {"ok": False, "error": "reference_list_not_found"}

    existing = _existing_card_names(tc, trello_board_id)
    created: list[str] = []
    skipped: list[str] = []

    for tmpl in templates:
        if tmpl.name in existing:
            skipped.append(tmpl.name)
            continue
        tc.create_card(list_id=ref_list_id, name=tmpl.name, desc=tmpl.desc)
        created.append(tmpl.name)

    write_audit(
        conn,
        action="trello.reference_cards.created",
        target=trello_board_id,
        payload={"created": created, "skipped": skipped},
        correlation_id=correlation_id,
    )
    return {
        "ok": True,
        "mode": "live",
        "board_id": trello_board_id,
        "cards_created": created,
        "cards_skipped": skipped,
    }
