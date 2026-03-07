"""Replace-between-markers content healing for Notion page blocks.

OpenClaw owns content between marker pairs:
  [[OPENCLAW:key:START]]
  ... managed content ...
  [[OPENCLAW:key:END]]

Human-authored content outside markers is never modified.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.block_markers")

_START_RE = re.compile(r"\[\[OPENCLAW:(.+?):START\]\]")
_END_RE = re.compile(r"\[\[OPENCLAW:(.+?):END\]\]")


@dataclass
class MarkerRegion:
    """A matched marker pair in a block list."""

    key: str
    start_index: int  # index of START marker block
    end_index: int  # index of END marker block


def find_marker_regions(blocks: list[dict[str, Any]]) -> list[MarkerRegion]:
    """Scan Notion block list and return all marker regions."""
    open_markers: dict[str, int] = {}
    regions: list[MarkerRegion] = []

    for i, block in enumerate(blocks):
        text = _extract_plain_text(block)
        if not text:
            continue

        start_match = _START_RE.search(text)
        if start_match:
            key = start_match.group(1)
            open_markers[key] = i
            continue

        end_match = _END_RE.search(text)
        if end_match:
            key = end_match.group(1)
            if key in open_markers:
                regions.append(MarkerRegion(
                    key=key,
                    start_index=open_markers.pop(key),
                    end_index=i,
                ))

    if open_markers:
        log.warning("unclosed_markers", extra={"keys": list(open_markers.keys())})

    return regions


def replace_between_markers(
    blocks: list[dict[str, Any]],
    key: str,
    new_children: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Replace blocks between START/END markers for a given key.

    Returns a new block list with content between markers replaced.
    Marker blocks themselves are preserved.
    """
    regions = find_marker_regions(blocks)
    region = next((r for r in regions if r.key == key), None)

    if region is None:
        log.info("marker_not_found", extra={"key": key})
        return blocks  # no change

    # Keep everything before start marker (inclusive), new children, then end marker (inclusive) onward
    before = blocks[: region.start_index + 1]
    after = blocks[region.end_index:]
    return before + new_children + after


def build_marker_block(key: str, position: str) -> dict[str, Any]:
    """Create a paragraph block containing a marker text.

    Args:
        key: The marker key (e.g., "financial_summary").
        position: "START" or "END".
    """
    text = f"[[OPENCLAW:{key}:{position}]]"
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "color": "gray",
        },
    }


def wrap_with_markers(
    key: str, children: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Wrap a list of blocks with START/END markers."""
    return [
        build_marker_block(key, "START"),
        *children,
        build_marker_block(key, "END"),
    ]


# ─────────────────────────────────────────
# Text-based marker replacement (for rich_text property approach)
# ─────────────────────────────────────────


def replace_between_markers_text(body: str, key: str, new_content: str) -> str:
    """Replace text between START/END markers in a plain-text string.

    Used by PortalBlockHealer when managing portal content via a single
    rich_text property rather than Notion child blocks.

    If markers don't exist, appends them with the new content.
    Human-authored text outside markers is preserved.
    """
    start_tag = f"[[OPENCLAW:{key}:START]]"
    end_tag = f"[[OPENCLAW:{key}:END]]"

    start_idx = body.find(start_tag)
    end_idx = body.find(end_tag)

    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        # Markers not found — append section
        return body.rstrip() + f"\n\n{start_tag}\n{new_content}\n{end_tag}\n"

    # Replace content between markers (preserve markers themselves)
    before = body[: start_idx + len(start_tag)]
    after = body[end_idx:]
    return before + "\n" + new_content + "\n" + after


def paragraph_block(text: str) -> dict[str, Any]:
    """Build a simple Notion paragraph block.

    Shared helper for all Notion writers — avoids duplicating _paragraph()
    in every writer module.
    """
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
        },
    }


def _extract_plain_text(block: dict[str, Any]) -> str:
    """Extract plain text from any Notion block."""
    btype = block.get("type", "")
    content = block.get(btype, {})
    rich_text = content.get("rich_text", [])
    parts: list[str] = []
    for t in rich_text:
        pt = t.get("plain_text") or t.get("text", {}).get("content", "")
        parts.append(pt)
    return "".join(parts)
