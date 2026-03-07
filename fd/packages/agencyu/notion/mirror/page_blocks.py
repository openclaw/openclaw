"""Standard Notion block builders for mirror writers.

Provides factory functions for common Notion block types used in client
portals and mirrored pages. All blocks conform to Notion API block format.
"""
from __future__ import annotations

from typing import Any


def heading_1(text: str, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "heading_1",
        "heading_1": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": color,
        },
    }


def heading_2(text: str, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "heading_2",
        "heading_2": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": color,
        },
    }


def heading_3(text: str, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "heading_3",
        "heading_3": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": color,
        },
    }


def paragraph(text: str, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": color,
        },
    }


def bulleted_list_item(text: str, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "bulleted_list_item",
        "bulleted_list_item": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": color,
        },
    }


def numbered_list_item(text: str, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "numbered_list_item",
        "numbered_list_item": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": color,
        },
    }


def callout(text: str, icon: str = "info", color: str = "blue_background") -> dict[str, Any]:
    icon_map = {
        "info": "\u2139\ufe0f",
        "warning": "\u26a0\ufe0f",
        "check": "\u2705",
        "lock": "\U0001f512",
        "money": "\U0001f4b0",
    }
    emoji = icon_map.get(icon, icon)
    return {
        "object": "block",
        "type": "callout",
        "callout": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "icon": {"type": "emoji", "emoji": emoji},
            "color": color,
        },
    }


def to_do(text: str, checked: bool = False, color: str = "default") -> dict[str, Any]:
    return {
        "object": "block",
        "type": "to_do",
        "to_do": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "checked": checked,
            "color": color,
        },
    }


def divider() -> dict[str, Any]:
    return {"object": "block", "type": "divider", "divider": {}}


def table_of_contents() -> dict[str, Any]:
    return {
        "object": "block",
        "type": "table_of_contents",
        "table_of_contents": {"color": "default"},
    }


def toggle(text: str, children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    block: dict[str, Any] = {
        "object": "block",
        "type": "toggle",
        "toggle": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": "default",
        },
    }
    if children:
        block["toggle"]["children"] = children
    return block


def linked_db_view(database_id: str) -> dict[str, Any]:
    """Embed a linked database view block."""
    return {
        "object": "block",
        "type": "child_database",
        "child_database": {"title": ""},
    }


def kv_row(label: str, value: str) -> dict[str, Any]:
    """A bulleted list item formatted as 'Label: Value'."""
    return bulleted_list_item(f"{label}: {value}")
