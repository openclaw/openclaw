"""cc.approvals widget — Pending approvals summary with Telegram deep link.

Shows pending approval count, top items, and a link to open the Telegram bot.

Marker: [[OPENCLAW:CC_APPROVALS:START/END]]
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.messaging.approval_card import brand_chip, risk_chip
from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    callout,
    divider,
    heading_2,
    paragraph,
)
from packages.common.clock import utc_now_iso

MARKER_KEY = "CC_APPROVALS"


def render_cc_approvals(
    data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Render approvals widget blocks.

    Expected data keys:
        - pending_approvals: list of approval dicts
        - telegram_bot_username: str (for deep link)
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\u2705 Approvals"))
    blocks.append(paragraph(
        "Pending actions awaiting human approval. Approve/deny in Telegram.",
        color="gray",
    ))
    blocks.append(divider())

    pending = data.get("pending_approvals", [])
    tg_username = data.get("telegram_bot_username", "")

    if not pending:
        blocks.append(callout(
            "No pending approvals. All clear.",
            icon="check", color="green_background",
        ))
    else:
        blocks.append(callout(
            f"{len(pending)} pending approval(s) need attention.",
            icon="warning", color="yellow_background",
        ))

        # Show top 5
        for appr in pending[:5]:
            b = brand_chip(appr.get("brand", ""))
            r = risk_chip(appr.get("risk_level", ""))
            step_info = ""
            if appr.get("requires_two_step") and appr.get("status") == "APPROVED_STEP1":
                step_info = " [AWAITING CONFIRM]"
            elif appr.get("requires_two_step"):
                step_info = " [2-step]"

            line = (
                f"{b} | {appr.get('action_type', '?')}{step_info} | {r}\n"
                f"  ID: {appr.get('approval_id', '?')} | exp {appr.get('expires_at', '?')}"
            )
            blocks.append(bulleted_list_item(line))

        if len(pending) > 5:
            blocks.append(paragraph(
                f"... and {len(pending) - 5} more. Check Telegram for full list.",
                color="gray",
            ))

    if tg_username:
        blocks.append(paragraph(
            f"Open Telegram Bot: https://t.me/{tg_username}",
        ))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks
