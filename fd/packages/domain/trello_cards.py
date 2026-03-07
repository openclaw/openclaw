from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.integrations.trello.client import TrelloClient


def find_card_in_list_by_name(
    tc: TrelloClient, *, list_id: str, name: str
) -> dict[str, Any] | None:
    """Find a card by name in a specific list (exact then case-insensitive)."""
    cards = tc.get_cards_in_list(list_id=list_id)
    for c in cards:
        if c.get("name") == name:
            return c
    target = (name or "").strip().lower()
    for c in cards:
        if (c.get("name") or "").strip().lower() == target:
            return c
    return None


def upsert_card_top(
    conn: sqlite3.Connection,
    *,
    board_id: str,
    list_id: str,
    card_name: str,
    desc: str,
    correlation_id: str | None,
) -> str:
    """Create or update a card and position it at the top of the list."""
    tc = TrelloClient()
    existing = find_card_in_list_by_name(tc, list_id=list_id, name=card_name)

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="trello.card.upsert_top.simulated",
            target=board_id,
            payload={"card_name": card_name},
            correlation_id=correlation_id,
        )
        return existing["id"] if existing else f"dry_card_{card_name.lower().replace(' ', '_')}"

    if existing:
        tc.update_card(card_id=existing["id"], desc=desc, pos="top")
        return existing["id"]

    created = tc.create_card(list_id=list_id, name=card_name, desc=desc)
    tc.update_card(card_id=created["id"], pos="top")
    return created["id"]


def update_card_desc_append(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    append_block: str,
    correlation_id: str | None,
) -> None:
    """Append a block of text to a card's description (idempotent)."""
    tc = TrelloClient()
    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="trello.card.append_desc.simulated",
            target=card_id,
            payload={},
            correlation_id=correlation_id,
        )
        return

    card = tc.get_card(card_id=card_id)
    current = card.get("desc") or ""
    # Prevent duplicate append if already present verbatim
    if append_block.strip() and append_block.strip() in current:
        return
    new_desc = (current.rstrip() + "\n\n" + append_block.strip()).strip()
    tc.update_card(card_id=card_id, desc=new_desc)


def upsert_marked_block(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    begin_marker: str,
    end_marker: str,
    block_body: str,
    correlation_id: str | None,
) -> None:
    """Replace (or insert) a canonical block between markers in card description.

    - If markers exist: replace everything between them (inclusive) with new block.
    - If markers do not exist: append the block at end (separated by blank line).
    - SAFE_MODE/DRY_RUN: no Trello mutation.
    """
    tc = TrelloClient()

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="trello.card.upsert_marked_block.simulated",
            target=card_id,
            payload={"begin": begin_marker, "end": end_marker},
            correlation_id=correlation_id,
        )
        return

    card = tc.get_card(card_id=card_id)
    desc = card.get("desc") or ""

    begin = begin_marker.strip()
    end = end_marker.strip()
    body = block_body.strip()

    new_block = f"{begin}\n{body}\n{end}"

    if begin in desc and end in desc:
        # Replace first occurrence only (deterministic)
        pre = desc.split(begin, 1)[0].rstrip()
        post_part = desc.split(end, 1)
        post = post_part[1].lstrip() if len(post_part) > 1 else ""
        new_desc = (pre + "\n\n" + new_block + "\n\n" + post).strip()
    else:
        base = desc.strip()
        new_desc = (base + "\n\n" + new_block).strip() if base else new_block

    tc.update_card(card_id=card_id, desc=new_desc)

    write_audit(
        conn,
        action="trello.card.upsert_marked_block.applied",
        target=card_id,
        payload={"begin": begin, "end": end},
        correlation_id=correlation_id,
    )


def remove_marked_block(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    begin_marker: str,
    end_marker: str,
    correlation_id: str | None,
) -> bool:
    """Remove the first occurrence of a marked block (inclusive) from card description.

    Returns True if removed (or would remove), False if not found.
    SAFE_MODE/DRY_RUN: no Trello mutation.
    """
    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="trello.card.remove_marked_block.simulated",
            target=card_id,
            payload={"begin": begin_marker, "end": end_marker},
            correlation_id=correlation_id,
        )
        return True

    tc = TrelloClient()
    card = tc.get_card(card_id=card_id)
    desc = card.get("desc") or ""

    begin = begin_marker.strip()
    end = end_marker.strip()

    if begin not in desc or end not in desc:
        return False

    pre = desc.split(begin, 1)[0].rstrip()
    post_part = desc.split(end, 1)
    tail = post_part[1].lstrip() if len(post_part) > 1 else ""
    new_desc = (pre + "\n\n" + tail).strip()

    tc.update_card(card_id=card_id, desc=new_desc)

    write_audit(
        conn,
        action="trello.card.remove_marked_block.applied",
        target=card_id,
        payload={"begin": begin, "end": end},
        correlation_id=correlation_id,
    )
    return True


def upsert_marked_json_merge(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    begin_marker: str,
    end_marker: str,
    merge_fn: Callable[[dict[str, Any] | None], dict[str, Any]],
    correlation_id: str | None,
) -> dict[str, Any]:
    """Read an existing marked JSON block, parse it, call merge_fn(existing),
    write merged JSON back between markers.

    SAFE_MODE/DRY_RUN: calls merge_fn(None) and audits without mutating.
    """
    if settings.DRY_RUN or settings.SAFE_MODE:
        merged = merge_fn(None)
        write_audit(
            conn,
            action="trello.card.upsert_marked_json_merge.simulated",
            target=card_id,
            payload={"begin": begin_marker, "end": end_marker},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "merged": merged}

    tc = TrelloClient()
    card = tc.get_card(card_id=card_id)
    desc = card.get("desc") or ""

    begin = begin_marker.strip()
    end = end_marker.strip()

    existing_obj: dict[str, Any] | None = None
    if begin in desc and end in desc:
        mid = desc.split(begin, 1)[1]
        body = mid.split(end, 1)[0].strip()
        if body:
            try:
                existing_obj = json.loads(body)
            except Exception:
                existing_obj = None

    merged = merge_fn(existing_obj)

    upsert_marked_block(
        conn,
        card_id=card_id,
        begin_marker=begin,
        end_marker=end,
        block_body=json.dumps(merged, separators=(",", ":")),
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": "live", "merged": merged}
