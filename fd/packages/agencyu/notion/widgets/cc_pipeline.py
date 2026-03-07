"""cc.pipeline widget — Pipeline stage counts and conversion metrics.

Shows CRM pipeline breakdown by stage with goal: move leads forward.

Marker: [[OPENCLAW:CC_PIPELINE:START/END]]
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

MARKER_KEY = "CC_PIPELINE"

_DASH = "\u2014"

REQUIRED_VIEW_KEYS = [
    "cc.pipeline_quality",
    "meetings.showed_7d",
]


def render_cc_pipeline(
    data: dict[str, Any],
    view_links: dict[str, ViewLink] | None = None,
) -> list[dict[str, Any]]:
    """Render pipeline widget blocks.

    Expected data keys: new_leads, qualified, booked, showed,
    closed_won, closed_lost.
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f4de Pipeline"))
    blocks.append(paragraph(
        "Goal: move leads forward. Open the pipeline board below.",
        color="gray",
    ))
    blocks.append(divider())

    blocks.append(bulleted_list_item(f"New leads: {data.get('new_leads', _DASH)}"))
    blocks.append(bulleted_list_item(f"Qualified: {data.get('qualified', _DASH)}"))
    blocks.append(bulleted_list_item(f"Booked: {data.get('booked', _DASH)}"))
    blocks.append(bulleted_list_item(f"Showed: {data.get('showed', _DASH)}"))
    blocks.append(bulleted_list_item(f"Closed won: {data.get('closed_won', _DASH)}"))
    blocks.append(bulleted_list_item(f"Closed lost: {data.get('closed_lost', _DASH)}"))

    if view_links:
        blocks.extend(render_view_links_blocks(view_links))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
