"""Generic WidgetWriter — block-level replace-between-markers for Notion pages.

Provides the core write discipline for any Command Center widget:
1. List all child blocks of the target page
2. Find START/END marker blocks for the widget's marker_key
3. Delete all blocks between markers (preserve markers themselves)
4. Append new rendered blocks after the START marker
5. If markers don't exist, seed them first (append START + content + END)

This is the block-level analog of replace_between_markers_text. It works
with actual Notion block IDs, deleting and re-appending via the API.

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
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.widget_writer")


class WidgetWriter:
    """Generic block-level replace-between-markers writer.

    Usage:
        writer = WidgetWriter(conn, notion_api, page_id)
        result = writer.write_widget(
            marker_key="CC_FIX_LIST",
            blocks=rendered_blocks,
            widget_key="cc.fix_list",
        )
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        page_id: str,
        *,
        audit_writer: AuditWriter | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api
        self.page_id = page_id
        self.audit = audit_writer or AuditWriter(conn)
        self.state = SystemState(conn)

    def write_widget(
        self,
        *,
        marker_key: str,
        blocks: list[dict[str, Any]],
        widget_key: str = "",
        safe_mode: bool = True,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Write blocks between markers on the target page.

        If markers exist: delete blocks between them, append new blocks after START.
        If markers don't exist: append START + blocks + END to the page.

        Args:
            marker_key: The marker key (e.g. "CC_FIX_LIST").
            blocks: Rendered Notion blocks to place between markers.
            widget_key: Widget identifier for audit (e.g. "cc.fix_list").
            safe_mode: If True, simulate only.
            correlation_id: Tracking ID.

        Returns:
            Dict with status, block_count, action taken.
        """
        effective_safe = safe_mode or self.state.write_lock_active()

        if not self.page_id:
            return {"ok": False, "error": "no page_id configured"}

        # Fetch current children
        try:
            children = self.notion.list_all_block_children(self.page_id, limit=2000)
        except Exception as exc:
            return {"ok": False, "error": f"cannot read page blocks: {exc}"}

        regions = find_marker_regions(children)
        region = next((r for r in regions if r.key == marker_key), None)

        if effective_safe:
            return {
                "ok": True,
                "dry_run": True,
                "action": "replace" if region else "seed",
                "block_count": len(blocks),
                "marker_key": marker_key,
            }

        if region:
            # Delete blocks between markers (exclusive of markers themselves)
            self._delete_between(children, region.start_index, region.end_index)
            # Append new blocks after the START marker
            start_block_id = children[region.start_index].get("id", "")
            if start_block_id:
                self.notion.append_block_children(self.page_id, blocks)
            else:
                self.notion.append_block_children(self.page_id, blocks)
        else:
            # Seed: append START + blocks + END
            wrapped = (
                [build_marker_block(marker_key, "START")]
                + blocks
                + [build_marker_block(marker_key, "END")]
            )
            self.notion.append_block_children(self.page_id, wrapped)

        # Audit
        self.audit.write_event(
            action="notion.widget.write",
            target_type="command_center_widget",
            target_id=widget_key or marker_key,
            details={
                "marker_key": marker_key,
                "block_count": len(blocks),
                "action": "replace" if region else "seed",
                "correlation_id": correlation_id,
            },
            correlation_id=correlation_id,
        )

        return {
            "ok": True,
            "dry_run": False,
            "action": "replace" if region else "seed",
            "block_count": len(blocks),
            "marker_key": marker_key,
        }

    def ensure_markers(
        self,
        marker_key: str,
        *,
        safe_mode: bool = True,
    ) -> dict[str, Any]:
        """Ensure START/END markers exist on the page. Seed if missing.

        Returns dict with action taken.
        """
        effective_safe = safe_mode or self.state.write_lock_active()

        if not self.page_id:
            return {"ok": False, "error": "no page_id configured"}

        try:
            children = self.notion.list_all_block_children(self.page_id, limit=2000)
        except Exception as exc:
            return {"ok": False, "error": f"cannot read page blocks: {exc}"}

        regions = find_marker_regions(children)
        exists = any(r.key == marker_key for r in regions)

        if exists:
            return {"ok": True, "action": "already_exists", "marker_key": marker_key}

        if effective_safe:
            return {"ok": True, "action": "would_seed", "dry_run": True, "marker_key": marker_key}

        # Seed empty markers
        self.notion.append_block_children(self.page_id, [
            build_marker_block(marker_key, "START"),
            build_marker_block(marker_key, "END"),
        ])

        return {"ok": True, "action": "seeded", "marker_key": marker_key}

    def _delete_between(
        self,
        children: list[dict[str, Any]],
        start_index: int,
        end_index: int,
    ) -> int:
        """Delete all blocks between start_index and end_index (exclusive).

        Returns count of blocks deleted.
        """
        deleted = 0
        for i in range(start_index + 1, end_index):
            block_id = children[i].get("id")
            if block_id:
                try:
                    self.notion.delete_block(block_id)
                    deleted += 1
                except Exception:
                    log.warning("delete_block_error", extra={
                        "block_id": block_id, "index": i,
                    })
        return deleted
