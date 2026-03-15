"""
bodhi_vault.obsidian_sync — Fire-and-forget sync from vault nodes to an Obsidian vault.

Disabled automatically when OBSIDIAN_VAULT_PATH is unset.
Never raises — vault writes succeed regardless of Obsidian state.

Writes Markdown files with YAML frontmatter compatible with the Obsidian
Dataview plugin. Each node becomes a file that Dataview can query:

    TABLE energy, domain, tags FROM "domains/wellness"
    WHERE energy >= 4
    SORT created_at DESC

Directory layout inside the Obsidian vault:
    domains/{domain}/YYYY-MM-DD-{node_id}.md  — one file per node
    people/{person-name}.md                    — one file per person, appended

Environment variables:
    OBSIDIAN_VAULT_PATH — Absolute path to the Obsidian vault root directory.
                          If unset, all sync functions are silent no-ops.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Domain → subdirectory mapping
# ---------------------------------------------------------------------------

DOMAIN_DIR: dict[str | None, str] = {
    "wellness": "wellness",
    "fitness": "fitness",
    "health": "health",
    "mental-health": "mental-health",
    "cognitive": "cognitive",
    "trading": "trading",
    "business": "business",
}
DEFAULT_DIR = "uncategorized"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _vault_path() -> Path | None:
    """Return the configured Obsidian vault root, or None when unset."""
    raw = os.environ.get("OBSIDIAN_VAULT_PATH", "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_dir():
        log.debug("obsidian: OBSIDIAN_VAULT_PATH does not exist: %s", p)
        return None
    return p


def _safe_filename(node_id: str) -> bool:
    """Validate node IDs before using them in file paths (UUID format expected)."""
    return bool(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", node_id))


def _safe_person_name(name: str) -> str:
    """Sanitize person name for use as a filename. Removes path separators."""
    # Strip characters that are invalid in filenames across OS
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip()
    return cleaned[:80] or "unknown"


def _write_atomic(path: Path, content: str) -> None:
    """Write content atomically: temp file in same dir, then os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_str = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    tmp = Path(tmp_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Markdown formatters
# ---------------------------------------------------------------------------


def _node_to_obsidian_md(node: dict[str, Any]) -> str:
    """
    Convert a vault node to an Obsidian Markdown file with Dataview-compatible
    YAML frontmatter.

    Frontmatter fields match the Node schema exactly. Tags use YAML list form
    to handle values with spaces or special characters safely.
    """
    lines: list[str] = ["---"]

    # Core fields — always present
    lines.append(f"bodhi_id: {node.get('id', '')}")
    lines.append(f"type: {node.get('type', 'Idea')}")
    lines.append(f"energy: {node.get('energy_level', 3)}")
    lines.append(f"source: {node.get('source', 'telegram')}")
    lines.append(f"media_type: {node.get('media_type', 'text')}")

    # Timestamps
    created = node.get("created_at", "")
    if created:
        lines.append(f"created_at: {created[:19]}")  # trim sub-second precision

    # Domain
    domain = node.get("domain") or DEFAULT_DIR
    lines.append(f"domain: {domain}")

    # Tags — YAML list form (safe for any content)
    tags = node.get("tags", [])
    if tags:
        lines.append("tags:")
        for t in tags:
            lines.append(f"  - {t}")
    else:
        lines.append("tags: []")

    # People — YAML list form
    people = node.get("people", [])
    if people:
        lines.append("people:")
        for p in people:
            lines.append(f"  - \"{p}\"")

    # Optional metadata
    if node.get("social_context"):
        lines.append(f"social_context: {node['social_context']}")
    if node.get("cluster_id"):
        lines.append(f"cluster_id: {node['cluster_id']}")
    if node.get("promoted_from"):
        lines.append(f"promoted_from: {node['promoted_from']}")
    if node.get("media_ref"):
        # Never write Telegram file_ids to Obsidian — they're ephemeral and expose nothing useful
        # Write only if it's a URL (e.g. for links)
        ref = node["media_ref"]
        if ref.startswith("http"):
            lines.append(f"media_ref: {ref}")

    lines.append("---")
    lines.append("")

    # Body
    content = node.get("content", "").strip()
    if content:
        lines.append(content)
        lines.append("")

    # Enriched content as a callout block (Obsidian callout syntax)
    enriched = node.get("content_enriched", "")
    if enriched and enriched.strip():
        lines.append("> [!note]+ Enriched")
        for line in enriched.strip().splitlines():
            lines.append(f"> {line}")
        lines.append("")

    return "\n".join(lines)


def _interaction_block(node: dict[str, Any]) -> str:
    """Format one interaction entry for appending to a person note."""
    ts = node.get("created_at", "")[:19].replace("T", " ")
    domain = node.get("domain", "")
    content = node.get("content", "").strip()
    tags_str = ", ".join(f"`{t}`" for t in node.get("tags", []))
    return f"\n### {ts} · {domain}\n\n{content}\n\n{tags_str}\n"


# ---------------------------------------------------------------------------
# Sync operations
# ---------------------------------------------------------------------------


def sync_node(node: dict[str, Any], vault: Path) -> None:
    """Write a vault node as an Obsidian Markdown file."""
    node_id = node.get("id", "")
    if not _safe_filename(node_id):
        log.debug("obsidian: skipping node with non-UUID id: %r", node_id)
        return

    domain = node.get("domain") or DEFAULT_DIR
    subdir = DOMAIN_DIR.get(domain, DEFAULT_DIR)

    # File: domains/{subdir}/YYYY-MM-DD-{id}.md
    date_prefix = node.get("created_at", "undated")[:10]
    filename = f"{date_prefix}-{node_id}.md"
    dest = vault / "domains" / subdir / filename

    try:
        content = _node_to_obsidian_md(node)
        _write_atomic(dest, content)
    except Exception as exc:
        log.debug("obsidian sync_node failed for %s: %s", node_id, exc)


def sync_person_notes(node: dict[str, Any], vault: Path) -> None:
    """
    Upsert person notes in the vault's people/ directory.

    One Markdown file per person. Each node encounter appends a dated
    interaction block. Creates the file if it doesn't exist yet.
    """
    people = node.get("people", [])
    if not people:
        return

    interaction = _interaction_block(node)

    for person in people:
        safe_name = _safe_person_name(person)
        if not safe_name or safe_name == "unknown":
            continue

        dest = vault / "people" / f"{safe_name}.md"

        try:
            if dest.exists():
                existing = dest.read_text(encoding="utf-8")
                updated = existing.rstrip() + "\n" + interaction
                _write_atomic(dest, updated)
            else:
                initial = f"# {person}\n\n---\n{interaction}"
                _write_atomic(dest, initial)
        except Exception as exc:
            log.debug("obsidian sync_person_notes failed for %r: %s", person, exc)


# ---------------------------------------------------------------------------
# Module-level entry point (fire-and-forget)
# ---------------------------------------------------------------------------


def sync_to_obsidian(node: dict[str, Any]) -> None:
    """
    Sync a vault node to an Obsidian vault. Safe to call unconditionally —
    silently disabled when OBSIDIAN_VAULT_PATH is not set.

    Never raises. Vault writes are independent of Obsidian availability.
    """
    vault = _vault_path()
    if vault is None:
        return

    try:
        sync_node(node, vault)
        if node.get("people"):
            sync_person_notes(node, vault)
    except Exception as exc:  # noqa: BLE001
        # Best-effort — never propagate to caller
        log.debug("obsidian sync skipped: %s", exc)
