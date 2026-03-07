"""Notion VSL Writer — mirrors VSL variant performance to Notion."""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.marketing.vsl_optimizer import analyze_vsl, get_all_vsl_ids
from packages.agencyu.notion.mirror.block_markers import paragraph_block as _paragraph, wrap_with_markers
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.vsl_writer")


def build_vsl_performance_blocks(
    conn: sqlite3.Connection,
    brand: str,
) -> list[dict[str, Any]]:
    """Build Notion blocks for VSL variant performance summary."""
    children: list[dict[str, Any]] = []

    vsl_ids = get_all_vsl_ids(conn, window_days=30)
    if not vsl_ids:
        children.append(_paragraph("No VSL data in the last 30 days."))
        return wrap_with_markers("vsl_performance", children)

    for vsl_id in vsl_ids[:5]:
        report = analyze_vsl(conn, vsl_id, window_days=30)
        children.append(_paragraph(f"VSL: {vsl_id} — {report.total_views} views"))

        if report.winner:
            w = report.winner
            children.append(_paragraph(
                f"  Winner: {w.variant_id} — "
                f"Watch {w.avg_watch_pct:.0f}% | CTA {w.cta_click_rate:.1%} | "
                f"Book {w.booking_rate:.1%} | Conv {w.conversion_rate:.1%}"
            ))

        if "warning" in report.recommendation:
            children.append(_paragraph(f"  ⚠️ {report.recommendation}"))
        elif report.winner:
            children.append(_paragraph(f"  ✅ {report.recommendation}"))
        else:
            children.append(_paragraph(f"  📊 {report.recommendation}"))

    return wrap_with_markers("vsl_performance", children)


