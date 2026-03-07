"""Detect missing or broken view keys in the Views Registry.

Provides two helpers:
- required_view_keys_minimum() — canonical list of required view_key strings
- find_missing_view_keys() — queries the Views Registry DB and returns
  view_keys that are either unregistered or whose pages are inaccessible.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.views_registry.spec import minimum_view_specs
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.views_registry.checks")


def required_view_keys_minimum() -> list[str]:
    """Return the canonical list of required view_key strings."""
    return [s.view_key for s in minimum_view_specs()]


def find_missing_view_keys(
    api: NotionAPI,
    *,
    views_registry_db_id: str,
    required_keys: list[str] | None = None,
) -> list[str]:
    """Find view_keys that are missing or broken in the Views Registry DB.

    A key is "missing" if:
    - No registry row exists with that title
    - The row exists but the referenced page is inaccessible

    Args:
        api: NotionAPI instance.
        views_registry_db_id: ID of the Views Registry database.
        required_keys: Keys to check. Defaults to minimum_view_specs keys.

    Returns:
        List of missing/broken view_key strings.
    """
    if not views_registry_db_id:
        log.warning("find_missing_view_keys: no views_registry_db_id provided")
        return list(required_keys or required_view_keys_minimum())

    keys = required_keys or required_view_keys_minimum()
    missing: list[str] = []

    # Load all rows once for efficiency
    try:
        all_rows = api.query_all_database_rows(views_registry_db_id)
    except Exception as exc:
        log.warning("find_missing_view_keys: query failed", extra={"error": str(exc)})
        return list(keys)

    # Build title → row lookup
    row_by_title: dict[str, dict[str, Any]] = {}
    for row in all_rows:
        title = api._page_title(row).strip().lower()
        row_by_title[title] = row

    for key in keys:
        row = row_by_title.get(key.strip().lower())
        if not row:
            missing.append(key)
            continue

        # Row exists — check if page is accessible
        page_id = _extract_page_id(row)
        if not page_id:
            missing.append(key)
            continue

        try:
            if not api.can_read_page(page_id):
                missing.append(key)
        except Exception:
            missing.append(key)

    return missing


def _extract_page_id(row: dict[str, Any]) -> str | None:
    """Extract page_id from registry row Notes field (matches healer convention)."""
    props = row.get("properties", {})
    notes_prop = props.get("Notes", {})
    rich_text = notes_prop.get("rich_text", [])
    if not rich_text:
        return None
    notes_text = rich_text[0].get("plain_text", "")
    if "Page:" in notes_text:
        for part in notes_text.split("."):
            part = part.strip()
            if part.startswith("Page:"):
                return part.replace("Page:", "").strip()
    return None
