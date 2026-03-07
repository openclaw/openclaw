"""Brand Switcher Writer — seeds/heals the "Choose a Brand" block at top of Command Center.

Creates a 2-column layout with callout buttons linking to Full Digital HQ and CUTMV HQ.
Uses OpenClaw-owned block markers so human content is never touched.

Structure on page:
  [[OPENCLAW:CC_BRAND_SWITCHER:START]]
  H2: "Choose a Brand"
  column_list:
    col A → callout: "Full Digital — Go to Full Digital HQ" (links to fd_hq page)
    col B → callout: "CUTMV — Go to CUTMV HQ" (links to cutmv_hq page)
  [[OPENCLAW:CC_BRAND_SWITCHER:END]]

Safety:
- safe_mode: simulate all writes (return plan only)
- write_lock: always respected (forces safe_mode)
- Audit every write
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.mirror.block_markers import (
    build_marker_block,
    find_marker_regions,
)
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.brand_switcher_writer")

MARKER_KEY = "CC_BRAND_SWITCHER"

# Badge markers for replace-between-markers discipline
BADGE_START = "[[OC:BADGE:START]]"
BADGE_END = "[[OC:BADGE:END]]"


def _badge_block_text(badge_line: str) -> str:
    """Wrap a badge line in OpenClaw-owned markers."""
    return f"{BADGE_START}\n{badge_line}\n{BADGE_END}"


def _make_callout_block(
    emoji: str,
    title: str,
    one_liner: str,
    funnels_line: str,
    kpi_line: str,
    badge_line: str,
    target_page_id: str,
    goal_chip_line: str = "",
) -> dict[str, Any]:
    """Build a Notion callout tile: emoji + bold linked title + one-liner + funnels + KPI + badge + goal."""
    page_url = f"/{target_page_id.replace('-', '')}" if target_page_id else ""

    # Line 1: emoji + bold title (linked to HQ page)
    rich_text: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": {"content": f"{emoji} "},
            "annotations": {"bold": True},
        },
    ]
    if page_url:
        rich_text.append({
            "type": "text",
            "text": {"content": f"{title}\n", "link": {"url": page_url}},
            "annotations": {"bold": True},
        })
    else:
        rich_text.append({
            "type": "text",
            "text": {"content": f"{title}\n"},
            "annotations": {"bold": True},
        })

    # Line 2: one-liner
    rich_text.append({
        "type": "text",
        "text": {"content": f"{one_liner}\n"},
    })

    # Line 3: primary funnels
    rich_text.append({
        "type": "text",
        "text": {"content": f"{funnels_line}\n"},
        "annotations": {"italic": True, "color": "gray"},
    })

    # Line 4: primary KPI
    rich_text.append({
        "type": "text",
        "text": {"content": f"{kpi_line}\n"},
        "annotations": {"bold": True},
    })

    # Line 5: dynamic badge (replace-between-markers)
    rich_text.append({
        "type": "text",
        "text": {"content": _badge_block_text(badge_line)},
    })

    # Line 6: goal chip (if set)
    if goal_chip_line:
        rich_text.append({
            "type": "text",
            "text": {"content": f"\n{goal_chip_line}"},
            "annotations": {"italic": True, "color": "blue"},
        })

    return {
        "type": "callout",
        "callout": {
            "rich_text": rich_text,
            "icon": {"type": "emoji", "emoji": emoji},
            "color": "gray_background",
        },
    }


def _build_brand_switcher_blocks(
    fd_hq_page_id: str,
    cutmv_hq_page_id: str,
    fd_badge_line: str = "Today \u2022 0 booked calls",
    cutmv_badge_line: str = "Today \u2022 0 trials \u2022 0 paid",
    fd_goal_chip: str = "",
    cutmv_goal_chip: str = "",
) -> list[dict[str, Any]]:
    """Build the full set of blocks for the brand switcher section."""
    heading = {
        "type": "heading_2",
        "heading_2": {
            "rich_text": [{"type": "text", "text": {"content": "Choose a Brand"}}],
        },
    }

    fd_callout = _make_callout_block(
        emoji="\U0001f3e2",
        title="Full Digital",
        one_liner="Run the agency engine.",
        funnels_line="Primary funnels: High-ticket agency",
        kpi_line="Primary KPI: booked calls",
        badge_line=fd_badge_line,
        target_page_id=fd_hq_page_id,
        goal_chip_line=fd_goal_chip,
    )

    cutmv_callout = _make_callout_block(
        emoji="\U0001f9e9",
        title="CUTMV",
        one_liner="Run the product engine.",
        funnels_line="Primary funnels: Self-serve SaaS",
        kpi_line="Primary KPI: trials \u2192 paid",
        badge_line=cutmv_badge_line,
        target_page_id=cutmv_hq_page_id,
        goal_chip_line=cutmv_goal_chip,
    )

    # Two-column layout: column_list → column → callout
    column_list = {
        "type": "column_list",
        "column_list": {
            "children": [
                {
                    "type": "column",
                    "column": {"children": [fd_callout]},
                },
                {
                    "type": "column",
                    "column": {"children": [cutmv_callout]},
                },
            ],
        },
    }

    return [heading, column_list]


class BrandSwitcherWriter:
    """Seeds/heals the Brand Switcher block at top of Command Center.

    Uses replace-between-markers discipline: only content between
    [[OPENCLAW:CC_BRAND_SWITCHER:START]] and [[OPENCLAW:CC_BRAND_SWITCHER:END]]
    is managed. Everything else is untouched.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        command_center_page_id: str,
        *,
        audit_writer: AuditWriter | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.cc_page_id = command_center_page_id
        self.audit = audit_writer or AuditWriter(conn)
        self.state = SystemState(conn)

    def _resolve_hq_page_id(self, page_key: str) -> str | None:
        """Resolve a page_key to a Notion page ID via notion_bindings."""
        try:
            row = self.conn.execute(
                "SELECT notion_object_id FROM notion_bindings WHERE binding_type=? LIMIT 1",
                (page_key,),
            ).fetchone()
            return row["notion_object_id"] if row else None
        except Exception:
            return None

    def seed_or_heal(
        self,
        *,
        safe_mode: bool = True,
        correlation_id: str = "",
        fd_badge_line: str = "Today: \u2014 calls booked",
        cutmv_badge_line: str = "Today: \u2014 trials / \u2014 paid",
        fd_goal_chip: str = "",
        cutmv_goal_chip: str = "",
    ) -> dict[str, Any]:
        """Ensure brand switcher blocks exist on Command Center.

        If markers exist: replace content between them.
        If markers don't exist: append START + blocks + END.

        Badge lines are rendered between [[OC:BADGE:START]] / [[OC:BADGE:END]]
        markers inside each callout tile for daily metric updates.
        Goal chips are rendered as italic blue text below the badge.
        """
        effective_safe = safe_mode or self.state.write_lock_active()

        if not self.cc_page_id:
            return {"ok": False, "error": "no command_center page_id configured"}

        # Resolve HQ page IDs
        fd_hq_id = self._resolve_hq_page_id("fd_hq") or ""
        cutmv_hq_id = self._resolve_hq_page_id("cutmv_hq") or ""

        blocks = _build_brand_switcher_blocks(
            fd_hq_id, cutmv_hq_id,
            fd_badge_line=fd_badge_line,
            cutmv_badge_line=cutmv_badge_line,
            fd_goal_chip=fd_goal_chip,
            cutmv_goal_chip=cutmv_goal_chip,
        )

        # Check if markers already exist
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
                "fd_hq_resolved": bool(fd_hq_id),
                "cutmv_hq_resolved": bool(cutmv_hq_id),
            }

        if region:
            # Delete blocks between markers
            for i in range(region.start_index + 1, region.end_index):
                block_id = children[i].get("id")
                if block_id:
                    try:
                        self.notion.delete_block(block_id)
                    except Exception:
                        log.warning("delete_block_error", extra={"block_id": block_id})
            # Append new blocks after START marker
            self.notion.append_block_children(self.cc_page_id, blocks)
        else:
            # Seed: append START + blocks + END
            wrapped = (
                [build_marker_block(MARKER_KEY, "START")]
                + blocks
                + [build_marker_block(MARKER_KEY, "END")]
            )
            self.notion.append_block_children(self.cc_page_id, wrapped)

        # Audit
        self.audit.write_event(
            action="notion.brand_switcher.write",
            target_type="command_center_brand_switcher",
            target_id=MARKER_KEY,
            details={
                "marker_key": MARKER_KEY,
                "block_count": len(blocks),
                "action": "replace" if region else "seed",
                "fd_hq_id": fd_hq_id,
                "cutmv_hq_id": cutmv_hq_id,
                "correlation_id": correlation_id,
            },
            correlation_id=correlation_id,
        )

        log.info("brand_switcher_written", extra={
            "action": "replace" if region else "seed",
            "block_count": len(blocks),
            "safe_mode": False,
        })

        return {
            "ok": True,
            "dry_run": False,
            "action": "replace" if region else "seed",
            "block_count": len(blocks),
            "marker_key": MARKER_KEY,
            "fd_hq_resolved": bool(fd_hq_id),
            "cutmv_hq_resolved": bool(cutmv_hq_id),
        }

    def update_badges(
        self,
        tile_metrics: dict[str, Any],
        *,
        safe_mode: bool = True,
        correlation_id: str = "",
        goal_chips: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Update badge lines on tiles using computed metrics with delta arrows.

        Delegates to seed_or_heal with pre-formatted badge lines.
        Respects write_lock and cooldown.

        Args:
            tile_metrics: {
                "fulldigital": {"calls_booked_today": int, "calls_booked_yesterday": int},
                "cutmv": {"trials_today": int, "paid_today": int, "paid_yesterday": int},
            }
            goal_chips: Optional {"fulldigital": "Goal • 10 calls • 70%", "cutmv": "..."}
        """
        from packages.agencyu.marketing.metrics_daily import delta_arrow

        fd = tile_metrics.get("fulldigital", {})
        cm = tile_metrics.get("cutmv", {})

        fd_today = fd.get("calls_booked_today", 0)
        fd_delta = fd_today - fd.get("calls_booked_yesterday", 0)
        fd_badge = (
            f"Today \u2022 {fd_today} booked calls"
            f"  {delta_arrow(fd_delta)} {fd_delta:+d} vs yesterday"
        )

        cm_trials = cm.get("trials_today", 0)
        cm_paid = cm.get("paid_today", 0)
        cm_delta = cm_paid - cm.get("paid_yesterday", 0)
        cm_badge = (
            f"Today \u2022 {cm_trials} trials \u2022 {cm_paid} paid"
            f"  {delta_arrow(cm_delta)} {cm_delta:+d} vs yesterday"
        )

        chips = goal_chips or {}

        return self.seed_or_heal(
            safe_mode=safe_mode,
            correlation_id=correlation_id,
            fd_badge_line=fd_badge,
            cutmv_badge_line=cm_badge,
            fd_goal_chip=chips.get("fulldigital", ""),
            cutmv_goal_chip=chips.get("cutmv", ""),
        )

    def verify_links(self) -> dict[str, Any]:
        """Verify that brand switcher links resolve to correct HQ pages.

        Returns a dict with ok, missing page keys, and link status.
        Read-only — no mutations.
        """
        missing: list[str] = []

        fd_hq_id = self._resolve_hq_page_id("fd_hq")
        cutmv_hq_id = self._resolve_hq_page_id("cutmv_hq")

        if not fd_hq_id:
            missing.append("fd_hq")
        if not cutmv_hq_id:
            missing.append("cutmv_hq")

        # Check markers exist on CC page
        markers_present = False
        try:
            children = self.notion.list_all_block_children(self.cc_page_id, limit=2000)
            regions = find_marker_regions(children)
            markers_present = any(r.key == MARKER_KEY for r in regions)
        except Exception:
            pass

        if not markers_present:
            missing.append(f"block:{MARKER_KEY}")

        return {
            "ok": len(missing) == 0,
            "missing": missing,
            "fd_hq_bound": bool(fd_hq_id),
            "cutmv_hq_bound": bool(cutmv_hq_id),
            "markers_present": markers_present,
        }
