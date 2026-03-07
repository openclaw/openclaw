"""cc.quick_actions widget — Quick action links for Command Center.

Shows admin tool links and one-click actions.
In v1, renders as text + links. Later can become interactive buttons.

Marker: [[OPENCLAW:CC_QUICK_ACTIONS:START/END]]
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    divider,
    heading_2,
    paragraph,
)
from packages.common.clock import utc_now_iso

MARKER_KEY = "CC_QUICK_ACTIONS"


def render_cc_quick_actions(
    data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Render quick actions widget blocks.

    Expected data keys: links (dict of label -> url).
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\u2705 Quick Actions"))
    blocks.append(paragraph(
        "Press a button, the system does the work.",
        color="gray",
    ))
    blocks.append(divider())

    # Built-in admin links (always shown)
    blocks.append(bulleted_list_item("Admin \u2014 Quick Actions UI: /admin/ui/quick-actions"))
    blocks.append(bulleted_list_item("Fix Views Registry (Simulate): /admin/notion/views_registry/fix_all"))

    # User-configured links
    links = data.get("links", {})
    for label, url in links.items():
        blocks.append(bulleted_list_item(f"{label}: {url}"))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
