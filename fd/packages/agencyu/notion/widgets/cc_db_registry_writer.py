"""cc.db_registry writer — writes the DB Registry widget to Command Center.

Uses the standard WidgetWriter for block-level replace-between-markers.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.widgets.cc_db_registry import (
    MARKER_KEY,
    render_db_registry,
)
from packages.agencyu.notion.widgets.widget_writer import WidgetWriter
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.cc_db_registry_writer")


def write_cc_db_registry(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    db_root_page_url: str | None = None,
    skills_backlog: dict[str, Any],
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Render and write the DB Registry widget to Command Center.

    Args:
        conn: SQLite connection for audit + write_lock.
        notion_api: Notion API client.
        command_center_page_id: Target page for the widget.
        db_root_page_url: URL to OpenClaw Databases parent page.
        skills_backlog: Status dict (exists, compliant, db_url, etc.)
        safe_mode: If True, simulate only.
        correlation_id: Tracking ID.
    """
    blocks = render_db_registry(
        db_root_page_url=db_root_page_url,
        skills_backlog=skills_backlog,
    )

    writer = WidgetWriter(conn, notion_api, command_center_page_id)
    return writer.write_widget(
        marker_key=MARKER_KEY,
        blocks=blocks,
        widget_key="cc.db_registry",
        safe_mode=safe_mode,
        correlation_id=correlation_id,
    )


def ensure_cc_db_registry_markers(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Ensure DB Registry markers exist on Command Center page."""
    writer = WidgetWriter(conn, notion_api, command_center_page_id)
    return writer.ensure_markers(MARKER_KEY, safe_mode=safe_mode)
