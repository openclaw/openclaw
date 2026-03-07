"""Normalize messy request cards with a structured intake header.

On createCard in Requests list, write a BEGIN_INTAKE_HEADER / END_INTAKE_HEADER
block with extracted fields. Keeps original description text unchanged below.

SAFE_MODE/DRY_RUN: simulate only.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.aspect_ratio import detect_aspect_ratio_labels
from packages.domain.link_extraction import extract_links
from packages.domain.release_date_parser import extract_release_date
from packages.domain.trello_cards import upsert_marked_block

_BEGIN = "BEGIN_INTAKE_HEADER"
_END = "END_INTAKE_HEADER"

# Heuristic: email-to-board cards often contain forwarding markers
_EMAIL_HINTS = ("forwarded message", "from:", "sent:", "subject:", "date:")


def _detect_source(desc: str) -> str:
    """Heuristic source detection."""
    lower = (desc or "").lower()
    hits = sum(1 for h in _EMAIL_HINTS if h in lower)
    if hits >= 2:
        return "email_to_board"
    return "manual"


def normalize_intake(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    card_name: str,
    card_desc: str,
    list_name: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Write a structured intake header into the card description.

    Only fires for cards in the Requests list.
    Returns header dict or skip reason.
    """
    request_names = set(json.loads(settings.CLIENT_REQUEST_LIST_NAMES_JSON))
    if list_name not in request_names:
        return {"ok": True, "skipped": True, "reason": "not_request_list"}

    text = f"{card_name}\n{card_desc}"

    # Extract structured fields
    aspect_ratios = detect_aspect_ratio_labels(text)
    release_date = extract_release_date(text)
    links = extract_links(text)
    source = _detect_source(card_desc)

    header = {
        "type": "intake_header",
        "detected_aspect_ratios": aspect_ratios,
        "release_date_iso": release_date,
        "detected_links_count": len(links),
        "source": source,
        "normalized_ts": now_ts(),
    }

    header_body = json.dumps(header, separators=(",", ":"))

    upsert_marked_block(
        conn,
        card_id=card_id,
        begin_marker=_BEGIN,
        end_marker=_END,
        block_body=header_body,
        correlation_id=correlation_id,
    )

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    write_audit(
        conn,
        action="intake_normalizer.applied",
        target=card_id,
        payload={
            "mode": mode,
            "source": source,
            "aspect_ratios": aspect_ratios,
            "release_date": release_date,
            "links_count": len(links),
        },
        correlation_id=correlation_id,
    )

    return {"ok": True, "mode": mode, "header": header}
