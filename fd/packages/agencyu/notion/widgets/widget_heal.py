"""Widget heal dispatcher — write missing widgets to Command Center.

Used by the fix_list self-heal flow: when compliance detects missing widgets,
this module can write them with default (empty) data so they show up as
placeholders ready to be populated.

Each widget gets sensible defaults (dashes, empty lists) so the UI is
never blank — just shows "no data yet" state.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.widgets.widget_registry import WIDGET_BY_KEY, WidgetSpec
from packages.agencyu.notion.widgets.widget_writer import WidgetWriter
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.widget_heal")

# Default empty data for each widget type so they render with placeholder content.
_DEFAULT_DATA: dict[str, dict[str, Any]] = {
    "cc.kpis": {},
    "cc.pipeline": {},
    "cc.cash": {},
    "cc.calendar": {},
    "cc.alerts": {"alerts": []},
    "cc.projects": {},
    "cc.quick_actions": {"links": {}},
    "cc.db_registry": {"skills_backlog": {"exists": False}},
    "cc.global": {"brands": {}},
    "cc.fd": {"brands": {}},
    "cc.cutmv": {"brands": {}},
}


def write_widget_by_key(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    widget_key: str,
    data: dict[str, Any] | None = None,
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Write a single widget to Command Center by widget_key.

    Resolves the widget spec from registry, renders blocks via the
    RENDERER_MAP, and writes via WidgetWriter.

    Args:
        conn: SQLite connection for audit + write_lock.
        notion_api: Notion API client.
        command_center_page_id: Target CC page.
        widget_key: Widget to write (e.g. "cc.kpis").
        data: Data dict for the renderer. Falls back to defaults.
        safe_mode: If True, simulate only.
        correlation_id: Tracking ID.
    """
    spec = WIDGET_BY_KEY.get(widget_key)
    if not spec:
        return {"ok": False, "error": f"unknown widget_key: {widget_key}"}

    # Import renderer map at call time to avoid circular imports
    from packages.agencyu.notion.widgets.widget_renderers import RENDERER_MAP

    renderer_fn = RENDERER_MAP.get(spec.renderer)
    if not renderer_fn:
        return {"ok": False, "error": f"no renderer for {widget_key}"}

    effective_data = data if data is not None else _DEFAULT_DATA.get(widget_key, {})
    blocks = renderer_fn(effective_data, spec)

    writer = WidgetWriter(conn, notion_api, command_center_page_id)
    result = writer.write_widget(
        marker_key=spec.effective_marker_key,
        blocks=blocks,
        widget_key=widget_key,
        safe_mode=safe_mode,
        correlation_id=correlation_id,
    )

    log.info("widget_heal_write", extra={
        "widget_key": widget_key,
        "ok": result.get("ok"),
        "action": result.get("action"),
        "safe_mode": safe_mode,
    })

    return {"ok": True, "widget_key": widget_key, "result": result}


def heal_missing_widgets(
    *,
    conn: sqlite3.Connection,
    notion_api: NotionAPI,
    command_center_page_id: str,
    missing_widget_keys: list[str],
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Write all missing widgets to Command Center.

    Takes a list of missing widget_keys (from compliance verifier) and
    writes each one with default data.

    Returns summary of what was written/simulated.
    """
    results: list[dict[str, Any]] = []

    for wk in missing_widget_keys:
        r = write_widget_by_key(
            conn=conn,
            notion_api=notion_api,
            command_center_page_id=command_center_page_id,
            widget_key=wk,
            safe_mode=safe_mode,
            correlation_id=correlation_id,
        )
        results.append(r)

    written = [r for r in results if r.get("ok") and not r.get("result", {}).get("dry_run")]
    simulated = [r for r in results if r.get("ok") and r.get("result", {}).get("dry_run")]
    errors = [r for r in results if not r.get("ok")]

    return {
        "ok": len(errors) == 0,
        "safe_mode": safe_mode,
        "total": len(missing_widget_keys),
        "written": len(written),
        "simulated": len(simulated),
        "errors": len(errors),
        "results": results,
    }
