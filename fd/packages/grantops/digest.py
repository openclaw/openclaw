"""GrantOps Telegram digest — daily summaries and priority alerts.

Generates formatted messages for the Telegram bot. Does NOT send messages
directly — returns formatted text for the existing Telegram integration
to deliver.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.grantops.store import (
    get_summary_stats,
    list_action_needed,
    list_new_today,
    list_opportunities,
)


def format_daily_digest(conn: sqlite3.Connection) -> str:
    """Generate the daily GrantOps digest message for Telegram."""
    stats = get_summary_stats(conn)
    new = list_new_today(conn, limit=5)
    action = list_action_needed(conn, limit=3)

    lines = [
        "[GrantOps] Daily Digest",
        "",
        f"New today: {stats['new_today']}",
        f"High fit: {stats['high_fit']}",
        f"Drafts in review: {stats['drafts_in_review']}",
        f"Submissions pending: {stats['submissions_pending']}",
        f"Total awarded: ${stats['total_awarded_usd']:,.0f}",
    ]

    if stats.get("next_follow_up"):
        lines.append(f"Next follow-up: {stats['next_follow_up']}")

    if new:
        lines.append("")
        lines.append("-- New Opportunities --")
        for opp in new:
            deadline = opp.get("deadline", "No deadline")
            fit = opp.get("fit_score", 0)
            lines.append(f"  {opp['name']}")
            lines.append(f"    {opp.get('funder', '?')} | {deadline} | Fit: {fit:.2f}")

    if action:
        lines.append("")
        lines.append("-- Action Needed --")
        for item in action:
            lines.append(f"  {item.get('name', '?')}")
            reason = item.get("blocker_reason") or item.get("status", "?")
            lines.append(f"    Status: {reason}")

    return "\n".join(lines)


def format_high_priority_alert(opp: dict[str, Any]) -> str:
    """Format a high-priority opportunity alert for Telegram."""
    deadline = opp.get("deadline", "No deadline")
    amount = ""
    if opp.get("amount_min_usd") and opp.get("amount_max_usd"):
        amount = f"${opp['amount_min_usd']:,.0f} - ${opp['amount_max_usd']:,.0f}"
    elif opp.get("amount_max_usd"):
        amount = f"Up to ${opp['amount_max_usd']:,.0f}"

    lines = [
        "[GrantOps] High-Fit Opportunity",
        "",
        f"Funder: {opp.get('funder', 'Unknown')}",
        f"Grant: {opp.get('name', 'Untitled')}",
        f"Deadline: {deadline}",
    ]
    if amount:
        lines.append(f"Amount: {amount}")
    lines.extend([
        f"Fit Score: {opp.get('fit_score', 0):.2f}",
        f"Portal: {opp.get('portal_type', 'unknown')}",
        "",
        "[Start Draft] [Skip] [View in Notion]",
    ])
    return "\n".join(lines)


def format_package_approval_request(
    draft: dict[str, Any],
    opp: dict[str, Any],
) -> str:
    """Format a package approval request for Telegram."""
    lines = [
        "[GrantOps] Package Ready for Review",
        "",
        f"Opportunity: {opp.get('name', '?')}",
        f"Funder: {opp.get('funder', '?')}",
        f"Deadline: {opp.get('deadline', 'None')}",
        f"Draft: {draft.get('name', '?')}",
        f"Attachments: {'Ready' if draft.get('attachments_ready') else 'Missing'}",
        "",
        "[Approve] [Revise] [View in Notion]",
    ]
    return "\n".join(lines)


def format_submission_confirmation(sub: dict[str, Any]) -> str:
    """Format a submission confirmation for Telegram."""
    lines = [
        "[GrantOps] Submission Confirmed",
        "",
        f"Grant: {sub.get('name', '?')}",
        f"Method: {sub.get('method', '?')}",
        f"Confirmation: {sub.get('confirmation_id', 'N/A')}",
    ]
    if sub.get("follow_up_date"):
        lines.append(f"Follow up: {sub['follow_up_date']}")
    return "\n".join(lines)


def format_outcome_alert(sub: dict[str, Any]) -> str:
    """Format a grant outcome notification."""
    outcome = sub.get("outcome", "pending")
    emoji = {"awarded": "!", "declined": "x", "waitlisted": "?"}
    marker = emoji.get(outcome, "-")

    lines = [
        f"[GrantOps] Grant {outcome.title()} ({marker})",
        "",
        f"Grant: {sub.get('name', '?')}",
    ]
    if outcome == "awarded" and sub.get("award_amount_usd"):
        lines.append(f"Amount: ${sub['award_amount_usd']:,.0f}")
    return "\n".join(lines)
