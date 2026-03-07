"""cc.alerts widget — System and business alerts.

Shows actionable alerts that need attention. No alerts = all clear.

Marker: [[OPENCLAW:CC_ALERTS:START/END]]
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
from packages.common.clock import utc_now_iso

MARKER_KEY = "CC_ALERTS"


def render_cc_alerts(
    data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Render alerts widget blocks.

    Expected data keys: alerts (list of strings).
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f6a8 Alerts"))
    blocks.append(paragraph(
        "If something is wrong, it shows up here.",
        color="gray",
    ))
    blocks.append(divider())

    alerts = data.get("alerts", [])
    if not alerts:
        blocks.append(callout(
            "All clear. No alerts right now.",
            icon="check", color="green_background",
        ))
    else:
        blocks.append(callout(
            f"{len(alerts)} alert(s) need attention.",
            icon="warning", color="red_background",
        ))
        for alert in alerts:
            blocks.append(bulleted_list_item(alert))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
