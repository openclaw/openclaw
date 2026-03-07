"""Rerender Command Center widgets — bulk write with default data.

Calls write_widget_by_key for each CC widget key, using default
(empty/placeholder) data so the UI always shows something.

Used by the fix_all endpoint to refresh all widgets in one pass.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.widgets.widget_heal import write_widget_by_key
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.rerender")

DEFAULT_CC_WIDGET_KEYS = [
    "cc.kpis",
    "cc.pipeline",
    "cc.cash",
    "cc.calendar",
    "cc.alerts",
    "cc.projects",
    "cc.quick_actions",
]


def rerender_command_center_widgets(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    safe_mode: bool = True,
    correlation_id: str = "",
    widget_keys: list[str] | None = None,
) -> dict[str, Any]:
    """Write all CC widgets with default data.

    Args:
        conn: SQLite connection for audit + write_lock.
        notion_api: Notion API client.
        command_center_page_id: Target CC page.
        safe_mode: If True, simulate only.
        correlation_id: Tracking ID.
        widget_keys: Override list of widget keys. Defaults to DEFAULT_CC_WIDGET_KEYS.
    """
    keys = widget_keys or DEFAULT_CC_WIDGET_KEYS
    results: list[dict[str, Any]] = []

    for widget_key in keys:
        res = write_widget_by_key(
            conn=conn,
            notion_api=notion_api,
            command_center_page_id=command_center_page_id,
            widget_key=widget_key,
            safe_mode=safe_mode,
            correlation_id=correlation_id,
        )
        results.append({"widget_key": widget_key, "result": res})

    ok_count = sum(1 for r in results if r["result"].get("ok"))
    err_count = len(results) - ok_count

    log.info("rerender_widgets_done", extra={
        "safe_mode": safe_mode,
        "total": len(results),
        "ok": ok_count,
        "errors": err_count,
    })

    return {
        "ok": err_count == 0,
        "safe_mode": safe_mode,
        "total": len(results),
        "ok_count": ok_count,
        "error_count": err_count,
        "results": results,
    }
