"""Stamp a canonical Publish Receipt block when a card moves to Published / Delivered.

Markers: BEGIN_PUBLISH_RECEIPT / END_PUBLISH_RECEIPT

Payload:
  {
    "type": "publish_receipt",
    "published_ts": ...,
    "correlation_id": "...",
    "final_links_count": N,
    "truth_badge": "published"
  }

Nothing is deleted — history is preserved. SAFE_MODE/DRY_RUN: simulate only.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.trello_cards import upsert_marked_block
from packages.domain.trello_lists import CanonicalClientLists
from packages.integrations.trello.client import TrelloClient

_LISTS = CanonicalClientLists()
_BEGIN = "BEGIN_PUBLISH_RECEIPT"
_END = "END_PUBLISH_RECEIPT"


def _read_delivery_block(desc: str) -> dict[str, Any]:
    """Parse delivery links JSON from card description."""
    begin = settings.MARKER_BEGIN_DELIVERY_LINKS
    end = settings.MARKER_END_DELIVERY_LINKS
    if begin not in desc or end not in desc:
        return {}
    mid = desc.split(begin, 1)[1]
    body = mid.split(end, 1)[0].strip()
    if not body:
        return {}
    try:
        return json.loads(body)
    except Exception:
        return {}


def stamp_publish_receipt(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    board_id: str,
    to_list_name: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Write a Publish Receipt block when card reaches Published / Delivered.

    Only fires for moves into the canonical Published list.
    Returns receipt dict or skip reason.
    """
    if to_list_name != _LISTS.published:
        return {"ok": True, "skipped": True, "reason": "not_published_list"}

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"

    # Read current delivery block to count final links
    final_links_count = 0
    delivery: dict[str, Any] = {}
    if not (settings.DRY_RUN or settings.SAFE_MODE):
        try:
            tc = TrelloClient()
            card = tc.get_card(card_id=card_id)
            desc = card.get("desc") or ""
            delivery = _read_delivery_block(desc)
            finals = delivery.get("final") or []
            final_links_count = len(finals) if isinstance(finals, list) else 0
        except Exception:
            pass

    receipt = {
        "type": "publish_receipt",
        "published_ts": now_ts(),
        "correlation_id": correlation_id,
        "final_links_count": final_links_count,
        "truth_badge": "published",
    }

    receipt_body = json.dumps(receipt, separators=(",", ":"))

    upsert_marked_block(
        conn,
        card_id=card_id,
        begin_marker=_BEGIN,
        end_marker=_END,
        block_body=receipt_body,
        correlation_id=correlation_id,
    )

    write_audit(
        conn,
        action="publish_receipt.stamped",
        target=card_id,
        payload={
            "mode": mode,
            "board_id": board_id,
            "final_links_count": final_links_count,
        },
        correlation_id=correlation_id,
    )

    return {"ok": True, "mode": mode, "receipt": receipt}
