"""cc.fix_list widget — renders compliance gaps as an actionable Fix List.

Consumes a ComplianceResult (from either SQLite or live-API verifier) and
produces Notion blocks grouped by category with repair instructions.

Uses the standard [[OPENCLAW:CC_FIX_LIST:START/END]] marker convention.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.agencyu.notion.compliance_models import ComplianceResult
from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    callout,
    divider,
    heading_2,
    paragraph,
)
from packages.common.clock import utc_now_iso

MARKER_KEY = "CC_FIX_LIST"


@dataclass(frozen=True)
class FixItem:
    """A single compliance gap needing repair."""

    category: str  # pages, databases, properties, views, widgets, portal_sections
    key: str  # Identifier (page_key, db_key, widget_key, etc.)
    detail: str  # Human-readable description
    repair_hint: str  # What to do


def build_fix_items(result: ComplianceResult) -> list[FixItem]:
    """Extract FixItems from a ComplianceResult."""
    items: list[FixItem] = []

    for p in result.missing_pages:
        items.append(FixItem(
            category="pages",
            key=p,
            detail=f"Page '{p}' not found in workspace",
            repair_hint="Create this page in Notion under the root workspace.",
        ))

    for d in result.missing_db_keys:
        items.append(FixItem(
            category="databases",
            key=d,
            detail=f"Database '{d}' not found",
            repair_hint="Run the setup wizard or create this database manually.",
        ))

    for mp in result.missing_db_properties:
        suffix = f" (got {mp.actual_type})" if mp.actual_type else ""
        items.append(FixItem(
            category="properties",
            key=f"{mp.db_key}.{mp.property_key}",
            detail=f"{mp.db_key} missing property '{mp.property_key}' "
                   f"(expected {mp.expected_type}){suffix}",
            repair_hint=f"Add '{mp.property_key}' as {mp.expected_type} to the {mp.db_key} database.",
        ))

    for mv in result.missing_view_keys:
        items.append(FixItem(
            category="views",
            key=mv.view_key,
            detail=f"View '{mv.view_key}' missing (for {mv.db_key})",
            repair_hint="Add this as a row in the Views Registry database.",
        ))

    for w in result.missing_widgets:
        items.append(FixItem(
            category="widgets",
            key=w,
            detail=f"Widget '{w}' marker blocks missing from Command Center",
            repair_hint="Run the widget writer to create marker blocks.",
        ))

    for s in result.missing_portal_sections:
        items.append(FixItem(
            category="portal_sections",
            key=s,
            detail=f"Portal section '{s}' missing",
            repair_hint="Run the portal healer to create section blocks.",
        ))

    return items


def render_fix_list_blocks(result: ComplianceResult) -> list[dict[str, Any]]:
    """Render ComplianceResult into Notion blocks for the cc.fix_list widget.

    Groups items by category, shows counts, repair hints.
    5-year-old standard: simple, actionable, no jargon.
    """
    items = build_fix_items(result)
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f527 Fix List"))

    if not items:
        blocks.append(callout(
            "\u2705 Everything looks good! No fixes needed.",
            icon="check", color="green_background",
        ))
        blocks.append(paragraph(f"Checked: {utc_now_iso()}", color="gray"))
        return blocks

    blocks.append(paragraph(
        f"There are {len(items)} items that need fixing. Work through them in order.",
        color="gray",
    ))

    # Group by category
    grouped: dict[str, list[FixItem]] = {}
    for item in items:
        grouped.setdefault(item.category, []).append(item)

    category_meta = {
        "pages": ("\U0001f4c4", "Missing Pages", "red_background"),
        "databases": ("\U0001f5c4", "Missing Databases", "red_background"),
        "properties": ("\U0001f50d", "Missing Properties", "yellow_background"),
        "views": ("\U0001f4ca", "Missing Views", "yellow_background"),
        "widgets": ("\U0001f9e9", "Missing Widgets", "yellow_background"),
        "portal_sections": ("\U0001f4d1", "Missing Portal Sections", "yellow_background"),
    }

    for category in ["pages", "databases", "properties", "views", "widgets", "portal_sections"]:
        cat_items = grouped.get(category, [])
        if not cat_items:
            continue

        icon, label, color = category_meta[category]
        blocks.append(callout(
            f"{icon} {label} ({len(cat_items)})",
            icon="warning", color=color,
        ))

        for fi in cat_items:
            blocks.append(bulleted_list_item(fi.detail))

        # Repair hint (same for all items in category)
        blocks.append(paragraph(
            f"What should I do? {cat_items[0].repair_hint}",
            color="gray",
        ))

    blocks.append(divider())
    blocks.append(paragraph(
        "\U0001f680 To auto-fix: POST /admin/reconcile/heal (requires admin token)",
        color="gray",
    ))
    blocks.append(paragraph(f"Checked: {utc_now_iso()}", color="gray"))

    return blocks
