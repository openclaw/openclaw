"""cc.calendar widget — Today's meetings and call schedule.

Shows calls scheduled, showed, no-shows, and next call.

Marker: [[OPENCLAW:CC_CALENDAR:START/END]]
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

MARKER_KEY = "CC_CALENDAR"

_DASH = "\u2014"

REQUIRED_VIEW_KEYS = [
    "meetings.showed_7d",
]


def render_cc_calendar(
    data: dict[str, Any],
    view_links: dict[str, ViewLink] | None = None,
) -> list[dict[str, Any]]:
    """Render calendar widget blocks.

    Expected data keys: calls_scheduled_today, calls_showed_today,
    no_shows_today, next_call.
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f4c5 Meetings"))
    blocks.append(paragraph(
        "Today's calls. If it's booked, make sure it shows.",
        color="gray",
    ))
    blocks.append(divider())

    blocks.append(bulleted_list_item(f"Calls scheduled (today): {data.get('calls_scheduled_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Calls showed (today): {data.get('calls_showed_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"No-shows (today): {data.get('no_shows_today', _DASH)}"))
    blocks.append(bulleted_list_item(f"Next call: {data.get('next_call', _DASH)}"))

    if view_links:
        blocks.extend(render_view_links_blocks(view_links))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
