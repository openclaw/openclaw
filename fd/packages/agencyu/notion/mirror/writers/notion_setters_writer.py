"""Notion Setters Writer — mirrors setter routing leaderboard + audit to Notion."""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.marketing.setter_router import rank_setters
from packages.agencyu.notion.mirror.block_markers import paragraph_block as _paragraph, wrap_with_markers
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.setters_writer")


def build_setter_leaderboard_blocks(
    conn: sqlite3.Connection,
    brand: str,
) -> list[dict[str, Any]]:
    """Build Notion blocks for the setter leaderboard + routing audit."""
    children: list[dict[str, Any]] = []

    # Leaderboard
    candidates = rank_setters(conn, brand)
    if candidates:
        children.append(_paragraph(f"Setter Leaderboard ({len(candidates)} active)"))
        for i, c in enumerate(candidates[:10]):
            medal = ["🥇", "🥈", "🥉"][i] if i < 3 else f"#{i + 1}"
            avail = "✅" if c.available else f"❌ ({c.assigned_today}/{c.max_daily})"
            children.append(_paragraph(
                f"{medal} {c.display_name} — Score {c.composite_score:.0f} | "
                f"Close {c.close_rate_score:.0f} | Show {c.show_rate_score:.0f} | "
                f"Speed {c.speed_score:.0f} | {avail}"
            ))
    else:
        children.append(_paragraph("No setter data available."))

    # Recent routing decisions
    try:
        rows = conn.execute(
            """SELECT setter_name, lead_tier, lead_quality_score, routing_reason, created_at
               FROM setter_routing_log
               WHERE brand = ?
               ORDER BY created_at DESC
               LIMIT 5""",
            (brand,),
        ).fetchall()

        if rows:
            children.append(_paragraph("— Recent Routing —"))
            for r in rows:
                tier_icon = {"high": "🔴", "standard": "🟡", "training": "⚪"}.get(r["lead_tier"], "·")
                children.append(_paragraph(
                    f"{tier_icon} → {r['setter_name']} (quality {r['lead_quality_score']:.0f}) — {r['routing_reason'][:50]}"
                ))
    except Exception:
        pass

    return wrap_with_markers("setter_leaderboard", children)


