"""cc.skills_recommendations writer — writes Skills Scout widget to Command Center.

Uses the existing WidgetWriter with replace-between-markers.
Orchestrates: run scout -> render blocks -> write to Notion.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.widgets.cc_skills_recommendations import (
    MARKER_KEY,
    render_skills_recommendations,
)
from packages.agencyu.notion.widgets.widget_writer import WidgetWriter
from packages.agencyu.skills.models import ScoutReport
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.cc_skills_recommendations_writer")


def write_cc_skills_recommendations(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    report: ScoutReport,
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Render and write the cc.skills_recommendations widget.

    Args:
        conn: SQLite connection for audit + state.
        notion_api: Notion API client.
        command_center_page_id: Page ID of the Command Center.
        report: Pre-computed ScoutReport.
        safe_mode: If True, simulate only.
        correlation_id: Tracking ID.

    Returns:
        Dict with write result.
    """
    blocks = render_skills_recommendations(report, limit=7)

    writer = WidgetWriter(
        conn=conn,
        notion_api=notion_api,
        page_id=command_center_page_id,
    )

    result = writer.write_widget(
        marker_key=MARKER_KEY,
        blocks=blocks,
        widget_key="cc.skills_recommendations",
        safe_mode=safe_mode,
        correlation_id=correlation_id,
    )

    log.info("cc_skills_recommendations_write", extra={
        "ok": result.get("ok"),
        "action": result.get("action"),
        "block_count": result.get("block_count"),
        "candidates": len(report.candidates),
    })

    return result


def ensure_cc_skills_recommendations_markers(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Ensure CC_SKILLS_RECOMMENDATIONS markers exist on the Command Center page."""
    writer = WidgetWriter(
        conn=conn,
        notion_api=notion_api,
        page_id=command_center_page_id,
    )
    return writer.ensure_markers(MARKER_KEY, safe_mode=safe_mode)
