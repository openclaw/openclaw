"""cc.projects widget — Active Work summary.

Shows projects and tasks in progress, needs review, blocked.

Marker: [[OPENCLAW:CC_PROJECTS:START/END]]
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

MARKER_KEY = "CC_PROJECTS"

_DASH = "\u2014"

REQUIRED_VIEW_KEYS = [
    "cc.fulfillment_watchlist",
    "tasks.today",
]


def render_cc_projects(
    data: dict[str, Any],
    view_links: dict[str, ViewLink] | None = None,
) -> list[dict[str, Any]]:
    """Render projects widget blocks.

    Expected data keys: projects_in_progress, tasks_in_progress,
    needs_review, blocked.
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f6e0\ufe0f Active Work"))
    blocks.append(paragraph(
        "This is what the team is working on right now.",
        color="gray",
    ))
    blocks.append(divider())

    blocks.append(bulleted_list_item(f"Projects in progress: {data.get('projects_in_progress', _DASH)}"))
    blocks.append(bulleted_list_item(f"Tasks in progress: {data.get('tasks_in_progress', _DASH)}"))
    blocks.append(bulleted_list_item(f"Needs review: {data.get('needs_review', _DASH)}"))
    blocks.append(bulleted_list_item(f"Blocked: {data.get('blocked', _DASH)}"))

    if view_links:
        blocks.extend(render_view_links_blocks(view_links))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
