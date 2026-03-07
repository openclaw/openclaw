"""General bootstrap helpers for Notion DB creation.

Provides deterministic page creation under a known parent,
without relying on Notion Search.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.db_bootstrap")


@dataclass
class EnsurePageResult:
    ok: bool
    page_id: str
    page_url: str | None = None
    created: bool = False


def ensure_child_page(
    api: NotionAPI,
    parent_page_id: str,
    *,
    title: str,
    safe_mode: bool = True,
) -> EnsurePageResult:
    """Ensure a child page exists under the given parent.

    In v1, Notion API does not provide reliable "find child page by title"
    without Search. So:
    - safe_mode: return parent (no creation)
    - apply: create a child page for organization

    Returns:
        EnsurePageResult with the page_id to use as parent for DB creation.
    """
    if safe_mode:
        return EnsurePageResult(ok=True, page_id=parent_page_id, created=False)

    parent = {"type": "page_id", "page_id": parent_page_id}
    properties = {
        "title": {"title": [{"type": "text", "text": {"content": title}}]},
    }
    page_id = api.create_page(parent, properties)

    page_url = f"https://notion.so/{page_id.replace('-', '')}"

    log.info("child_page_created", extra={
        "parent_page_id": parent_page_id,
        "page_id": page_id,
        "title": title,
    })

    return EnsurePageResult(
        ok=True,
        page_id=page_id,
        page_url=page_url,
        created=True,
    )
