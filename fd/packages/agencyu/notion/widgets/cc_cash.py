"""cc.cash widget — Cash & Profit summary.

Shows revenue, spend, profit, outstanding invoices, CAC.

Marker: [[OPENCLAW:CC_CASH:START/END]]
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

MARKER_KEY = "CC_CASH"

_DASH = "\u2014"

REQUIRED_VIEW_KEYS = [
    "cc.finance_snapshot",
]


def render_cc_cash(
    data: dict[str, Any],
    view_links: dict[str, ViewLink] | None = None,
) -> list[dict[str, Any]]:
    """Render cash widget blocks.

    Expected data keys: revenue_7d, spend_7d, profit_7d,
    outstanding_invoices, ad_spend_today, cac_7d.
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f4b0 Cash & Profit"))
    blocks.append(paragraph(
        "Simple rule: revenue minus spend. Keep this green.",
        color="gray",
    ))
    blocks.append(divider())

    blocks.append(bulleted_list_item(f"Revenue (7d): {data.get('revenue_7d', _DASH)}"))
    blocks.append(bulleted_list_item(f"Spend (7d): {data.get('spend_7d', _DASH)}"))
    blocks.append(bulleted_list_item(f"Profit (7d): {data.get('profit_7d', _DASH)}"))
    blocks.append(bulleted_list_item(f"Outstanding invoices: {data.get('outstanding_invoices', _DASH)}"))
    blocks.append(bulleted_list_item(f"Ad spend (today): {data.get('ad_spend_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"CAC (7d): {data.get('cac_7d', _DASH)}"))

    if view_links:
        blocks.extend(render_view_links_blocks(view_links))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
