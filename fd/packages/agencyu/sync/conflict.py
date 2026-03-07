from __future__ import annotations

from typing import Any


def resolve_field_conflict(
    *,
    field_name: str,
    source_value: Any,
    notion_value: Any,
    override_owner: str | None,
    policy: str = "source_wins",
) -> tuple[Any, str]:
    """Resolve a field-level conflict between source and Notion values.

    Returns (resolved_value, policy_applied).

    Policies:
    - source_wins: source value takes precedence
    - notion_wins: Notion value takes precedence
    - manual_required: flag for human review (returns source_value as default)
    """
    if override_owner == "notion":
        return notion_value, "notion_override"

    if override_owner == "system":
        return source_value, "system_override"

    if policy == "source_wins":
        return source_value, "source_wins"

    if policy == "notion_wins":
        return notion_value, "notion_wins"

    return source_value, "manual_required"
