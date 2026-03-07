from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.delivery_links import merge_delivery_links
from packages.domain.link_extraction import (
    ExtractedLink,
    extract_and_classify,
    rank_for_human_summary,
)
from packages.domain.trello_cards import (
    remove_marked_block,
    upsert_marked_block,
)

BEGIN_JSON = settings.MARKER_BEGIN_LINKS_JSON
END_JSON = settings.MARKER_END_LINKS_JSON

BEGIN_HUMAN = settings.MARKER_BEGIN_LINKS_HUMAN
END_HUMAN = settings.MARKER_END_LINKS_HUMAN


def _human_lines(selected: list[ExtractedLink]) -> str:
    """Render a human-readable summary of the most relevant links."""
    order = ["ASSETS", "DRAFT", "FINAL", "SCHEDULE", "REFERENCE", "UNKNOWN"]
    grouped: dict[str, list[ExtractedLink]] = {k: [] for k in order}
    for lnk in selected:
        grouped.setdefault(lnk.role, []).append(lnk)

    labels = {
        "ASSETS": "Assets",
        "DRAFT": "Draft",
        "FINAL": "Final",
        "SCHEDULE": "Schedule",
        "REFERENCE": "Reference",
        "UNKNOWN": "Other",
    }

    lines = [
        "Links (summary)",
        "These are the most relevant links detected from the card description.",
        "",
    ]
    any_added = False
    for role in order:
        items = grouped.get(role) or []
        if not items:
            continue
        any_added = True
        lines.append(f"{labels.get(role, role.title())}:")
        for it in items:
            lines.append(f"- {it.url} ({it.kind})")
        lines.append("")
    if not any_added:
        lines.append("No links detected.")
        lines.append("")

    lines.append(
        "Final deliverables should be posted using the Delivery Links"
        " section or via the standardized delivery workflow."
    )
    return "\n".join(ln.rstrip() for ln in lines).strip()


def _select_for_human(links: list[ExtractedLink]) -> list[ExtractedLink]:
    """Pick the top links respecting per-role and total caps."""
    ranked = rank_for_human_summary(links)

    max_per_role = settings.LINKS_HUMAN_MAX_PER_ROLE
    max_total = settings.LINKS_HUMAN_MAX_TOTAL

    picked: list[ExtractedLink] = []
    per_role: dict[str, int] = {}

    for lnk in ranked:
        if len(picked) >= max_total:
            break
        cnt = per_role.get(lnk.role, 0)
        if cnt >= max_per_role:
            continue
        picked.append(lnk)
        per_role[lnk.role] = cnt + 1

    return picked


def enrich_card_description_with_links(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    desc: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Extract links and write human summary + machine JSON blocks.

    Auto-hides human block when no links exist.
    Auto-merges detected FINAL links into the Delivery Links block.
    """
    links = extract_and_classify(desc or "")
    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"

    # --- Auto-hide human summary when no links exist ---
    if len(links) == 0:
        remove_marked_block(
            conn,
            card_id=card_id,
            begin_marker=BEGIN_HUMAN,
            end_marker=END_HUMAN,
            correlation_id=correlation_id,
        )
        # Still keep/update machine JSON as empty
        upsert_marked_block(
            conn,
            card_id=card_id,
            begin_marker=BEGIN_JSON,
            end_marker=END_JSON,
            block_body=json.dumps(
                {"type": "links", "updated_ts": now_ts(), "links": [], "summary": []},
                separators=(",", ":"),
            ),
            correlation_id=correlation_id,
        )
        write_audit(
            conn,
            action="card.enrich_links.hidden_human_no_links",
            target=card_id,
            payload={"mode": mode},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": mode, "links": 0, "summary": 0}

    # --- Links exist: write human + JSON blocks ---
    selected = _select_for_human(links)

    payload = {
        "type": "links",
        "updated_ts": now_ts(),
        "links": [
            {
                "url": lnk.url,
                "kind": lnk.kind,
                "role": lnk.role,
                "confidence": round(lnk.confidence, 2),
            }
            for lnk in links
        ],
        "summary": [
            {
                "url": lnk.url,
                "kind": lnk.kind,
                "role": lnk.role,
                "confidence": round(lnk.confidence, 2),
            }
            for lnk in selected
        ],
    }

    # 1) Human summary block
    upsert_marked_block(
        conn,
        card_id=card_id,
        begin_marker=BEGIN_HUMAN,
        end_marker=END_HUMAN,
        block_body=_human_lines(selected),
        correlation_id=correlation_id,
    )

    # 2) Machine JSON block
    upsert_marked_block(
        conn,
        card_id=card_id,
        begin_marker=BEGIN_JSON,
        end_marker=END_JSON,
        block_body=json.dumps(payload, separators=(",", ":")),
        correlation_id=correlation_id,
    )

    # --- Auto-merge detected FINAL links into Delivery block ---
    detected_finals = [lnk.url for lnk in links if lnk.role == "FINAL"]
    if detected_finals:
        merge_delivery_links(
            conn,
            card_id=card_id,
            final_urls=detected_finals,
            source="auto_detected",
            correlation_id=correlation_id,
        )

    write_audit(
        conn,
        action="card.enrich_links.human_json_and_delivery_merge",
        target=card_id,
        payload={
            "mode": mode,
            "links": len(links),
            "summary": len(selected),
            "detected_finals": len(detected_finals),
        },
        correlation_id=correlation_id,
    )
    return {
        "ok": True,
        "mode": mode,
        "links": len(links),
        "summary": len(selected),
        "detected_finals": len(detected_finals),
    }
