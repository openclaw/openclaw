"""CC Today Panel Writer — seeds/heals the "Today" block on Command Center.

Renders a compact Today panel with:
  - Brand KPI chips + goal chips
  - Overdue deadlines count
  - Next up schedule preview
  - "Start the day" link to admin UI

Uses replace-between-markers discipline (schema-lock).
Only OpenClaw-owned blocks are touched.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.marketing.metrics_daily import (
    build_brand_tile_summary,
    delta_arrow,
)
from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.mirror.block_markers import (
    build_marker_block,
    find_marker_regions,
)
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.agencyu.schedule.query import (
    count_overdue_deadlines,
    get_today_schedule_focus,
)
from packages.agencyu.schedule.repo import GoalRepo
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.cc_today_panel")

MARKER_KEY = "CC_TODAY_PANEL"


def _build_brand_chip_line(
    brand_name: str,
    kpi_line: str,
    goal_chip: str,
) -> str:
    """Format a single brand chip line for Notion plain text."""
    parts = [f"{brand_name} \u2014 {kpi_line}"]
    if goal_chip:
        parts.append(f"  |  {goal_chip}")
    return "".join(parts)


def _build_today_blocks(
    conn: sqlite3.Connection,
    admin_base_url: str = "",
) -> list[dict[str, Any]]:
    """Build the full set of blocks for the Today panel."""

    # Brand KPI data
    tile_summary = build_brand_tile_summary(conn)
    fd_s = tile_summary["fulldigital"]
    cm_s = tile_summary["cutmv"]
    fd_delta = fd_s["calls_booked_today"] - fd_s["calls_booked_yesterday"]
    cm_delta = cm_s["paid_today"] - cm_s["paid_yesterday"]

    fd_kpi = (
        f"Today \u2022 {fd_s['calls_booked_today']} booked calls"
        f"  {delta_arrow(fd_delta)} {fd_delta:+d} vs yesterday"
    )
    cm_kpi = (
        f"Today \u2022 {cm_s['trials_today']} trials \u2022 {cm_s['paid_today']} paid"
        f"  {delta_arrow(cm_delta)} {cm_delta:+d} vs yesterday"
    )

    # Goal chips
    goal_repo = GoalRepo(conn)
    fd_goal = goal_repo.build_goal_chip("fulldigital", "daily")
    cm_goal = goal_repo.build_goal_chip("cutmv", "daily")

    fd_line = _build_brand_chip_line("Full Digital", fd_kpi, fd_goal.chip_text if fd_goal else "")
    cm_line = _build_brand_chip_line("CUTMV", cm_kpi, cm_goal.chip_text if cm_goal else "")

    # Overdue count
    overdue = count_overdue_deadlines(conn)
    overdue_text = f"Overdue deadlines: {overdue}" if overdue > 0 else "No overdue deadlines"

    # Focus window: timed up-next + today's deadlines
    focus = get_today_schedule_focus(conn, max_items=5)
    next_lines: list[str] = []
    for item in focus.get("up_next", [])[:5]:
        next_lines.append(f"{item['time']} \u2014 {item['title']} ({item['brand']})")

    deadline_lines: list[str] = []
    for item in focus.get("deadlines", [])[:5]:
        deadline_lines.append(f"Due: {item['title']} ({item['brand']})")

    # Build blocks
    blocks: list[dict[str, Any]] = []

    # Heading
    blocks.append({
        "type": "heading_2",
        "heading_2": {
            "rich_text": [{"type": "text", "text": {"content": "Today"}}],
        },
    })

    # Brand chips callout
    brand_rich_text: list[dict[str, Any]] = [
        {"type": "text", "text": {"content": fd_line + "\n"}, "annotations": {"bold": False}},
        {"type": "text", "text": {"content": cm_line}, "annotations": {"bold": False}},
    ]
    blocks.append({
        "type": "callout",
        "callout": {
            "rich_text": brand_rich_text,
            "icon": {"type": "emoji", "emoji": "\U0001f4ca"},
            "color": "gray_background",
        },
    })

    # Overdue callout (red if overdue, green if clear)
    overdue_color = "red_background" if overdue > 0 else "green_background"
    overdue_emoji = "\u26a0\ufe0f" if overdue > 0 else "\u2705"
    blocks.append({
        "type": "callout",
        "callout": {
            "rich_text": [{"type": "text", "text": {"content": overdue_text}}],
            "icon": {"type": "emoji", "emoji": overdue_emoji},
            "color": overdue_color,
        },
    })

    # Up Next callout (timed events in focus window)
    if next_lines:
        next_content = "Up Next:\n" + "\n".join(next_lines)
    else:
        next_content = "No upcoming timed events"

    blocks.append({
        "type": "callout",
        "callout": {
            "rich_text": [{"type": "text", "text": {"content": next_content}}],
            "icon": {"type": "emoji", "emoji": "\U0001f4c5"},
            "color": "blue_background",
        },
    })

    # Today's Deadlines callout
    if deadline_lines:
        dl_content = "Today's Deadlines:\n" + "\n".join(deadline_lines)
        blocks.append({
            "type": "callout",
            "callout": {
                "rich_text": [{"type": "text", "text": {"content": dl_content}}],
                "icon": {"type": "emoji", "emoji": "\U0001f4cb"},
                "color": "yellow_background",
            },
        })

    # Start the day link (points to admin UI)
    if admin_base_url:
        blocks.append({
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{
                    "type": "text",
                    "text": {
                        "content": "Start the day \u2192",
                        "link": {"url": f"{admin_base_url}/admin/today"},
                    },
                    "annotations": {"bold": True, "color": "blue"},
                }],
            },
        })

    return blocks


class CCTodayPanelWriter:
    """Seeds/heals the Today panel on Command Center.

    Uses replace-between-markers discipline.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        command_center_page_id: str,
        *,
        audit_writer: AuditWriter | None = None,
        admin_base_url: str = "",
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.cc_page_id = command_center_page_id
        self.audit = audit_writer or AuditWriter(conn)
        self.state = SystemState(conn)
        self.admin_base_url = admin_base_url

    def seed_or_heal(
        self,
        *,
        safe_mode: bool = True,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Ensure Today panel exists on Command Center.

        If markers exist: replace content between them.
        If markers don't exist: append START + blocks + END.
        """
        effective_safe = safe_mode or self.state.write_lock_active()

        if not self.cc_page_id:
            return {"ok": False, "error": "no command_center page_id configured"}

        blocks = _build_today_blocks(self.conn, self.admin_base_url)

        try:
            children = self.notion.list_all_block_children(self.cc_page_id, limit=2000)
        except Exception as exc:
            return {"ok": False, "error": f"cannot read page blocks: {exc}"}

        regions = find_marker_regions(children)
        region = next((r for r in regions if r.key == MARKER_KEY), None)

        if effective_safe:
            return {
                "ok": True,
                "dry_run": True,
                "action": "replace" if region else "seed",
                "block_count": len(blocks),
                "marker_key": MARKER_KEY,
            }

        if region:
            for i in range(region.start_index + 1, region.end_index):
                block_id = children[i].get("id")
                if block_id:
                    try:
                        self.notion.delete_block(block_id)
                    except Exception:
                        log.warning("delete_block_error", extra={"block_id": block_id})
            self.notion.append_block_children(self.cc_page_id, blocks)
        else:
            wrapped = (
                [build_marker_block(MARKER_KEY, "START")]
                + blocks
                + [build_marker_block(MARKER_KEY, "END")]
            )
            self.notion.append_block_children(self.cc_page_id, wrapped)

        self.audit.write_event(
            action="notion.today_panel.write",
            target_type="command_center_today_panel",
            target_id=MARKER_KEY,
            details={
                "marker_key": MARKER_KEY,
                "block_count": len(blocks),
                "action": "replace" if region else "seed",
                "correlation_id": correlation_id,
            },
            correlation_id=correlation_id,
        )

        log.info("today_panel_written", extra={
            "action": "replace" if region else "seed",
            "block_count": len(blocks),
        })

        return {
            "ok": True,
            "dry_run": False,
            "action": "replace" if region else "seed",
            "block_count": len(blocks),
            "marker_key": MARKER_KEY,
        }
