"""Extract links from Trello card comments and merge into delivery block.

Comment link classification:
  - Keywords "final", "delivered", "approved" -> FINAL
  - Keywords "draft", "preview", "wip" -> DRAFT
  - Ambiguous -> DRAFT (conservative default)

After merge, evaluates finalization gate (auto-moves only if gate passes).
Event-gated: each comment generates a unique delivery_event_id stamped in the
delivery block; finalization triggers only on the current event's extracted links.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.ids import new_id
from packages.domain.delivery_links import merge_delivery_links
from packages.domain.link_extraction import extract_links

_FINAL_KW = re.compile(r"\b(final|delivered|approved|publish|ready)\b", re.IGNORECASE)
_DRAFT_KW = re.compile(r"\b(draft|preview|wip|rough|concept)\b", re.IGNORECASE)


def _classify_comment_urls(
    comment_text: str,
    urls: list[str],
) -> tuple[list[str], list[str]]:
    """Classify extracted URLs as draft or final based on comment keywords.

    Returns (draft_urls, final_urls).
    """
    has_final_kw = bool(_FINAL_KW.search(comment_text))
    has_draft_kw = bool(_DRAFT_KW.search(comment_text))

    if has_final_kw and not has_draft_kw:
        return [], urls
    if has_draft_kw and not has_final_kw:
        return urls, []
    if has_final_kw and has_draft_kw:
        # Both keywords present — classify per-url by proximity (simplified: FINAL wins)
        return [], urls
    # No keywords — default to DRAFT (conservative)
    return urls, []


def enrich_comment_links(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    comment_text: str,
    board_id: str = "",
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Parse a comment for URLs, classify as DRAFT/FINAL, merge into delivery block.

    After merge, evaluates finalization gate if board_id is available.
    Returns dict with ok, mode, drafts, finals counts, gate result.
    """
    urls = extract_links(comment_text or "")
    if not urls:
        return {"ok": True, "links": 0, "drafts": 0, "finals": 0}

    draft_urls, final_urls = _classify_comment_urls(comment_text, urls)

    # Each comment event gets a unique delivery_event_id for gate tracking
    delivery_event_id = new_id("devent")

    merge_result: dict[str, Any] | None = None
    if draft_urls or final_urls:
        merge_result = merge_delivery_links(
            conn,
            card_id=card_id,
            draft_urls=draft_urls,
            final_urls=final_urls,
            source="comment_enrichment",
            delivery_event_id=delivery_event_id,
            correlation_id=correlation_id,
        )

    # Evaluate finalization gate after delivery links update
    # Event-gated: pass only *this event's* links, not historical ones
    gate_result: dict[str, Any] | None = None
    if board_id and (draft_urls or final_urls):
        from packages.domain.finalization_gate import evaluate_finalization

        gate_result = evaluate_finalization(
            conn,
            card_id=card_id,
            board_id=board_id,
            has_new_drafts=len(draft_urls) > 0,
            has_new_finals=len(final_urls) > 0,
            delivery_event_id=delivery_event_id,
            correlation_id=correlation_id,
        )

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    write_audit(
        conn,
        action="comment.enrich_links",
        target=card_id,
        payload={
            "mode": mode,
            "total_links": len(urls),
            "drafts": len(draft_urls),
            "finals": len(final_urls),
            "delivery_event_id": delivery_event_id,
        },
        correlation_id=correlation_id,
    )
    return {
        "ok": True,
        "mode": mode,
        "links": len(urls),
        "drafts": len(draft_urls),
        "finals": len(final_urls),
        "delivery_event_id": delivery_event_id,
        "merge": merge_result,
        "finalization_gate": gate_result,
    }
