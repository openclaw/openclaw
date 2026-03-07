"""Notion Offers Writer — mirrors offer rotation matrix + combo status to Notion.

Shows active combos, recent decisions, and primary offer focus.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.mirror.block_markers import paragraph_block as _paragraph, wrap_with_markers
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.offers_writer")


def build_offer_rotation_blocks(
    conn: sqlite3.Connection,
    brand: str,
) -> list[dict[str, Any]]:
    """Build Notion blocks for the offer rotation dashboard."""
    children: list[dict[str, Any]] = []

    # Active combos
    try:
        rows = conn.execute(
            """SELECT combo_id, offer_id, angle_id, status, impressions, conversions, roas
               FROM offer_angle_combos
               WHERE brand = ? AND status = 'active'
               ORDER BY roas DESC
               LIMIT 10""",
            (brand,),
        ).fetchall()

        children.append(_paragraph(f"Active combos: {len(rows)}"))
        for r in rows:
            roas = float(r["roas"] or 0)
            emoji = "🟢" if roas >= 2.0 else "🟡" if roas >= 1.0 else "🔴"
            children.append(_paragraph(
                f"{emoji} {r['offer_id']} × {r['angle_id']} — "
                f"ROAS {roas:.1f}x | {r['impressions']} imp | {r['conversions']} conv"
            ))
    except Exception:
        children.append(_paragraph("Offer rotation data unavailable."))

    # Recent decisions
    try:
        decisions = conn.execute(
            """SELECT combo_id, action, reason, created_at
               FROM offer_angle_decisions
               WHERE brand = ?
               ORDER BY created_at DESC
               LIMIT 5""",
            (brand,),
        ).fetchall()

        if decisions:
            children.append(_paragraph("— Recent Decisions —"))
            for d in decisions:
                icon = {"promote": "⬆️", "kill": "💀", "rotate": "🔄", "hold": "⏸️"}.get(d["action"], "·")
                children.append(_paragraph(
                    f"{icon} {d['action'].upper()}: {d['combo_id'][:40]} — {d['reason'][:60]}"
                ))
    except Exception:
        pass

    return wrap_with_markers("offer_rotation", children)


