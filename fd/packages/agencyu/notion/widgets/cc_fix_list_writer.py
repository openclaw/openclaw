"""cc.fix_list writer — orchestrates compliance check + render + write.

Combines:
1. Run NotionComplianceVerifier (or accept pre-computed ComplianceResult)
2. Render fix list blocks via cc_fix_list.render_fix_list_blocks()
3. Write to Command Center page via WidgetWriter

Exposes a single function: write_cc_fix_list()
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.compliance_models import ComplianceResult
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.widgets.cc_fix_list import (
    MARKER_KEY,
    render_fix_list_blocks,
)
from packages.agencyu.notion.widgets.widget_writer import WidgetWriter
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.cc_fix_list_writer")


def write_cc_fix_list(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    compliance_result: ComplianceResult,
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Render and write the cc.fix_list widget to the Command Center page.

    Args:
        conn: SQLite connection for audit + state.
        notion_api: Notion API client.
        command_center_page_id: Page ID of the Command Center.
        compliance_result: Pre-computed compliance result.
        safe_mode: If True, simulate only.
        correlation_id: Tracking ID.

    Returns:
        Dict with write result (ok, action, block_count, etc.).
    """
    blocks = render_fix_list_blocks(compliance_result)

    writer = WidgetWriter(
        conn=conn,
        notion_api=notion_api,
        page_id=command_center_page_id,
    )

    result = writer.write_widget(
        marker_key=MARKER_KEY,
        blocks=blocks,
        widget_key="cc.fix_list",
        safe_mode=safe_mode,
        correlation_id=correlation_id,
    )

    log.info("cc_fix_list_write", extra={
        "ok": result.get("ok"),
        "action": result.get("action"),
        "block_count": result.get("block_count"),
        "fix_count": compliance_result.fix_count,
        "compliant": compliance_result.compliant,
    })

    return result


def ensure_cc_fix_list_markers(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Ensure CC_FIX_LIST markers exist on the Command Center page.

    Call this during workspace bootstrap to pre-seed marker blocks.
    """
    writer = WidgetWriter(
        conn=conn,
        notion_api=notion_api,
        page_id=command_center_page_id,
    )
    return writer.ensure_markers(MARKER_KEY, safe_mode=safe_mode)
