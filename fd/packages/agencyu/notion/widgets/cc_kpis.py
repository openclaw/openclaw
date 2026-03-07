"""cc.kpis widget — Today at a Glance KPI strip.

Shows leads, calls, sales, revenue, ad spend for today.
Links to view pages from Views Registry.

Marker: [[OPENCLAW:CC_KPIS:START/END]]
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    callout,
    divider,
    heading_2,
    paragraph,
)
from packages.agencyu.notion.widgets.view_links import ViewLink, render_view_links_blocks
from packages.common.clock import utc_now_iso

MARKER_KEY = "CC_KPIS"

REQUIRED_VIEW_KEYS = [
    "cc.active_combos",
    "cc.pipeline_quality",
    "cc.finance_snapshot",
]

_DASH = "\u2014"


def render_cc_kpis(
    data: dict[str, Any],
    view_links: dict[str, ViewLink] | None = None,
) -> list[dict[str, Any]]:
    """Render KPIs widget blocks.

    Expected data keys: leads_today, calls_booked_today, calls_showed_today,
    sales_today, revenue_today, ad_spend_today.
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f4ca Today (KPIs)"))
    blocks.append(paragraph(
        "Check the numbers. Green = good. Yellow = watch. Red = fix now.",
        color="gray",
    ))
    blocks.append(divider())

    blocks.append(bulleted_list_item(f"Leads (today): {data.get('leads_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Calls booked (today): {data.get('calls_booked_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Calls showed (today): {data.get('calls_showed_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Sales (today): {data.get('sales_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Revenue (today): {data.get('revenue_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Ad spend (today): {data.get('ad_spend_today', _DASH)}"))

    if view_links:
        blocks.extend(render_view_links_blocks(view_links))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
