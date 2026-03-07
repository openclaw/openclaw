"""Canonical schema definition for the Skills Backlog DB.

Used by both verifier and drift healer. Single source of truth
for required properties, types, and select/multi-select options.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

NotionPropType = Literal[
    "title",
    "rich_text",
    "url",
    "number",
    "select",
    "multi_select",
    "date",
]


@dataclass(frozen=True)
class SelectOptions:
    required: list[str]


@dataclass(frozen=True)
class PropSpec:
    key: str
    notion_type: NotionPropType
    select_options: SelectOptions | None = None


SKILLS_BACKLOG_REQUIRED_PROPS: list[PropSpec] = [
    PropSpec("Name", "title"),
    PropSpec("skill_key", "rich_text"),
    PropSpec("source_url", "url"),
    PropSpec(
        "trust_tier",
        "select",
        SelectOptions(["official", "curated", "community", "unknown"]),
    ),
    PropSpec("fit_score", "number"),
    PropSpec("risk_score", "number"),
    PropSpec(
        "recommended_mode",
        "select",
        SelectOptions(["safe_only", "safe_then_confirm", "confirm_only", "do_not_install"]),
    ),
    PropSpec(
        "status",
        "select",
        SelectOptions(["New", "Reviewing", "Approved to Fork", "Forked", "Rejected"]),
    ),
    PropSpec(
        "pain_point",
        "multi_select",
        SelectOptions(["Persistent Memory"]),
    ),
    PropSpec("notes", "rich_text"),
    PropSpec("checklist_page_url", "url"),
    PropSpec("created_at", "date"),
    PropSpec("last_updated_at", "date"),
]


def required_prop_map() -> dict[str, PropSpec]:
    """Return a dict keyed by property name for quick lookup."""
    return {p.key: p for p in SKILLS_BACKLOG_REQUIRED_PROPS}


def notion_prop_type_from_db_property(prop: dict[str, Any]) -> str | None:
    """Extract the Notion property type from a raw DB property dict."""
    return prop.get("type")
