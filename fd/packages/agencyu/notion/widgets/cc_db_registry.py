"""cc.db_registry widget — shows database existence and compliance status.

Renders on Command Center so admins can see at a glance:
- Skills Backlog: exists / missing, compliant / not compliant
- Notion links to open DB + root page
- Action instructions for bootstrap/heal

Uses standard [[OPENCLAW:CC_DB_REGISTRY:START/END]] marker convention.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    callout,
    divider,
    heading_2,
    heading_3,
    paragraph,
)

MARKER_KEY = "CC_DB_REGISTRY"


def render_db_registry(
    *,
    db_root_page_url: str | None,
    skills_backlog: dict[str, Any],
) -> list[dict[str, Any]]:
    """Render the DB Registry widget blocks.

    Args:
        db_root_page_url: URL to the OpenClaw Databases parent page.
        skills_backlog: Dict with keys:
            - exists: bool
            - db_url: str | None
            - compliant: bool | None
            - missing_props_count: int | None
            - missing_options_count: int | None
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("Database Registry"))
    blocks.append(paragraph(
        "OpenClaw-managed databases and their compliance status.",
        color="gray",
    ))

    if db_root_page_url:
        blocks.append(paragraph(f"DB Home: {db_root_page_url}", color="gray"))

    blocks.append(divider())
    blocks.append(heading_3("Skills Backlog"))

    exists = skills_backlog.get("exists", False)
    compliant = skills_backlog.get("compliant")
    db_url = skills_backlog.get("db_url")

    if not exists:
        blocks.append(callout(
            "Status: MISSING",
            icon="warning",
            color="red_background",
        ))
        blocks.append(paragraph(
            "What should I do? Run POST /admin/notion/db/bootstrap_skills_backlog",
            color="gray",
        ))
        return blocks

    # DB exists
    status_icon = "check" if compliant else "warning"
    status_color = "green_background" if compliant else "yellow_background"
    status_text = "EXISTS + COMPLIANT" if compliant else "EXISTS + NOT COMPLIANT"

    blocks.append(callout(
        f"Status: {status_text}",
        icon=status_icon,
        color=status_color,
    ))

    if db_url:
        blocks.append(paragraph(f"Open DB: {db_url}", color="gray"))

    if compliant is False:
        mp = skills_backlog.get("missing_props_count", 0)
        mo = skills_backlog.get("missing_options_count", 0)
        blocks.append(bulleted_list_item(f"Missing props: {mp}"))
        blocks.append(bulleted_list_item(f"Missing options: {mo}"))
        blocks.append(paragraph(
            "What should I do? Run POST /admin/notion/skills_backlog/heal (safe-mode first)",
            color="gray",
        ))
    elif compliant is None:
        blocks.append(paragraph(
            "Compliance: UNKNOWN (not verified yet)",
            color="gray",
        ))

    return blocks
