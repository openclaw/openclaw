"""Notion Retainer Writer — mirrors retainer candidates + assets to Notion."""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.mirror.block_markers import paragraph_block as _paragraph, wrap_with_markers
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.retainer_writer")


def build_retainer_candidates_blocks(
    conn: sqlite3.Connection,
    brand: str,
) -> list[dict[str, Any]]:
    """Build Notion blocks for retainer candidate pipeline."""
    children: list[dict[str, Any]] = []

    try:
        rows = conn.execute(
            """SELECT client_contact_key, brand, total_spend_cents, projects_completed,
                      retainer_offer_id, status, detected_at
               FROM retainer_candidates
               WHERE brand = ? AND status NOT IN ('dismissed')
               ORDER BY total_spend_cents DESC
               LIMIT 15""",
            (brand,),
        ).fetchall()

        if rows:
            # Summary counts
            by_status: dict[str, int] = {}
            for r in rows:
                by_status[r["status"]] = by_status.get(r["status"], 0) + 1

            status_line = " | ".join(f"{k}: {v}" for k, v in sorted(by_status.items()))
            children.append(_paragraph(f"Retainer Pipeline: {len(rows)} candidates — {status_line}"))

            for r in rows:
                spend = int(r["total_spend_cents"] or 0)
                icon = {
                    "detected": "🔍",
                    "assets_generated": "📄",
                    "outreach_queued": "📬",
                    "converted": "✅",
                }.get(r["status"], "·")
                children.append(_paragraph(
                    f"{icon} {r['client_contact_key'][:20]} — "
                    f"${spend / 100:,.0f} spent | {r['projects_completed']} projects | "
                    f"→ {r['retainer_offer_id']} ({r['status']})"
                ))
        else:
            children.append(_paragraph("No retainer candidates detected."))
    except Exception:
        children.append(_paragraph("Retainer data unavailable."))

    return wrap_with_markers("retainer_pipeline", children)


