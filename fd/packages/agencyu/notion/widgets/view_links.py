"""View links helper — resolve view_key to page URL via Views Registry DB.

The Views Registry DB stores rows with view_key, page_id, database_id.
This helper queries the DB for a specific view_key and returns the page URL
if the view is registered, or a "missing" result with repair instructions.

This is the clean workaround for Notion's API not supporting view enumeration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.view_links")


@dataclass
class ViewLink:
    """Resolved view link from Views Registry."""

    view_key: str
    page_url: str | None
    ok: bool
    note: str = ""


def resolve_view_link(
    api: NotionAPI,
    views_registry_db_id: str,
    view_key: str,
) -> ViewLink:
    """Look up a view_key in the Views Registry DB and return its page URL.

    Queries the Views Registry for a row where view_key matches.
    Returns the page_url if found, or a missing result.
    """
    if not views_registry_db_id:
        return ViewLink(
            view_key=view_key,
            page_url=None,
            ok=False,
            note="views_registry_db_id not configured",
        )

    try:
        result = api.query_database(
            views_registry_db_id,
            filter_obj={
                "property": "view_key",
                "rich_text": {"equals": view_key},
            },
        )
        rows = result.get("results", [])
        if not rows:
            return ViewLink(
                view_key=view_key,
                page_url=None,
                ok=False,
                note="not registered in Views Registry",
            )

        row = rows[0]
        # Try to get page_id from the row properties
        props = row.get("properties", {})
        page_id_prop = props.get("page_id", {})
        rich_text = page_id_prop.get("rich_text", [])
        page_id = rich_text[0].get("plain_text", "") if rich_text else ""

        if page_id:
            page_url = f"https://notion.so/{page_id.replace('-', '')}"
            return ViewLink(view_key=view_key, page_url=page_url, ok=True)

        # Fall back to row URL
        row_url = row.get("url")
        if row_url:
            return ViewLink(view_key=view_key, page_url=row_url, ok=True)

        return ViewLink(
            view_key=view_key,
            page_url=None,
            ok=False,
            note="view registered but no page_id set",
        )

    except Exception as exc:
        log.warning("resolve_view_link_error", extra={
            "view_key": view_key,
            "error": str(exc),
        })
        return ViewLink(
            view_key=view_key,
            page_url=None,
            ok=False,
            note=f"lookup error: {exc}",
        )


def resolve_view_links(
    api: NotionAPI,
    views_registry_db_id: str,
    view_keys: list[str],
) -> dict[str, ViewLink]:
    """Resolve multiple view_keys in bulk. Returns dict keyed by view_key."""
    return {
        vk: resolve_view_link(api, views_registry_db_id, vk)
        for vk in view_keys
    }


def render_view_links_blocks(
    view_links: dict[str, ViewLink],
) -> list[dict[str, Any]]:
    """Render view links as Notion blocks.

    Shows links for registered views and repair hints for missing ones.
    """
    from packages.agencyu.notion.mirror.page_blocks import bulleted_list_item, paragraph

    blocks: list[dict[str, Any]] = []

    missing = [vl for vl in view_links.values() if not vl.ok]
    found = [vl for vl in view_links.values() if vl.ok]

    for vl in found:
        blocks.append(bulleted_list_item(f"Open: {vl.view_key} \u2192 {vl.page_url}"))

    if missing:
        keys = ", ".join(vl.view_key for vl in missing)
        blocks.append(paragraph(
            f"Missing views: {keys} (register in Views Registry DB)",
            color="gray",
        ))

    return blocks
