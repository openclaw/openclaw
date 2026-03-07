"""Command Center widget renderers for GrantOps.

Renders Notion block content for the five grant widgets.
Follows the existing widget renderer pattern: each function returns
a list of Notion block dicts.
"""
from __future__ import annotations

from typing import Any


def render_grants_summary_widget(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Render the GrantOps summary widget — key metrics at a glance."""
    stats = data.get("stats", {})

    new_today = stats.get("new_today", 0)
    high_fit = stats.get("high_fit", 0)
    drafts_review = stats.get("drafts_in_review", 0)
    subs_pending = stats.get("submissions_pending", 0)
    total_awarded = stats.get("total_awarded_usd", 0)
    next_followup = stats.get("next_follow_up", "None")

    summary_text = (
        f"New today: {new_today} | "
        f"High fit: {high_fit} | "
        f"Drafts in review: {drafts_review} | "
        f"Submissions pending: {subs_pending}\n"
        f"Total awarded: ${total_awarded:,.0f} | "
        f"Next follow-up: {next_followup or 'None'}"
    )

    return [
        {
            "object": "block",
            "type": "callout",
            "callout": {
                "icon": {"type": "emoji", "emoji": "\U0001f3db"},
                "rich_text": [{"type": "text", "text": {"content": summary_text}}],
                "color": "blue_background" if subs_pending == 0 else "yellow_background",
            },
        }
    ]


def render_grants_new_today_widget(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Render today's new grant opportunities."""
    opportunities = data.get("new_today", [])

    if not opportunities:
        return [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": "No new opportunities today."}}],
                },
            }
        ]

    blocks: list[dict[str, Any]] = []
    for opp in opportunities[:5]:
        name = opp.get("name", "Untitled")
        funder = opp.get("funder", "Unknown")
        deadline = opp.get("deadline", "No deadline")
        fit = opp.get("fit_score", 0)
        portal = opp.get("portal_type", "?")

        text = f"{name}\n  {funder} | Deadline: {deadline} | Fit: {fit:.2f} | Portal: {portal}"
        blocks.append({
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": text}}],
                "color": "green" if fit >= 0.7 else "default",
            },
        })

    return blocks


def render_grants_high_priority_widget(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Render high-priority opportunities that need immediate action."""
    opps = data.get("high_priority", [])

    if not opps:
        return [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": "No high-priority opportunities."}}],
                },
            }
        ]

    blocks: list[dict[str, Any]] = []
    for opp in opps[:5]:
        name = opp.get("name", "Untitled")
        fit = opp.get("fit_score", 0)
        effort = opp.get("effort_score", 0)
        priority = opp.get("priority", "medium")
        deadline = opp.get("deadline", "No deadline")

        color = "red" if priority == "urgent" else "orange"
        text = f"[{priority.upper()}] {name} (fit: {fit:.2f}, effort: {effort:.2f}) | Deadline: {deadline}"

        blocks.append({
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": text}}],
                "color": color,
            },
        })

    return blocks


def render_grants_packages_review_widget(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Render draft packages awaiting review."""
    drafts = data.get("packages_review", [])

    if not drafts:
        return [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": "No packages awaiting review."}}],
                },
            }
        ]

    blocks: list[dict[str, Any]] = []
    for draft in drafts[:5]:
        name = draft.get("name", "Untitled")
        reviewer = draft.get("reviewer", "Unassigned")
        attachments = "Ready" if draft.get("attachments_ready") else "Missing"

        text = f"{name} | Reviewer: {reviewer} | Attachments: {attachments}"
        blocks.append({
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": text}}],
            },
        })

    return blocks


def render_grants_submissions_action_widget(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Render submissions that need human action."""
    items = data.get("action_needed", [])

    if not items:
        return [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": "No submissions need action."}}],
                },
            }
        ]

    blocks: list[dict[str, Any]] = []
    for item in items[:5]:
        name = item.get("name", "Untitled")
        method = item.get("method", "?")
        status = item.get("status", "?")
        blocker = item.get("blocker_reason", "")

        text = f"{name} | Method: {method} | Status: {status}"
        if blocker:
            text += f" | Blocker: {blocker}"

        blocks.append({
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": text}}],
                "color": "red" if status == "blocked" else "orange",
            },
        })

    return blocks
