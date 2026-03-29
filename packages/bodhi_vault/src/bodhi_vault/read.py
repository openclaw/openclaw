"""
bodhi_vault.read — Query helpers for the vault.

All reads go through this module. No worker reads JSON files directly.

The vault directory structure:
    vault/
        nodes/
            2026-03/
                <uuid>.md
                <uuid>.md
            2026-04/
                ...
        edges/
            <uuid>.json
        manifest.json

Reads scan the nodes/ subtree. No database — pure filesystem.
For the scale of a personal vault (hundreds to low thousands of nodes),
filesystem scan is fast enough and keeps dependencies minimal.

Nodes are stored as Markdown files with YAML frontmatter. For backward
compatibility, JSON files are also supported during migration.
"""

import json
from pathlib import Path
from typing import Any, Optional

import yaml


def _parse_markdown(text: str) -> dict[str, Any] | None:
    """
    Parse a Markdown node file with YAML frontmatter.

    Format:
        ---
        id: ...
        type: ...
        ...
        ---
        <content>
    """
    lines = text.split("\n")

    # Find opening ---
    if not lines or lines[0].strip() != "---":
        return None

    # Find closing ---
    closing_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            closing_idx = i
            break

    if closing_idx is None:
        return None

    # Extract frontmatter and content
    frontmatter_text = "\n".join(lines[1:closing_idx])
    content = "\n".join(lines[closing_idx + 1:])

    try:
        frontmatter = yaml.safe_load(frontmatter_text) or {}
    except yaml.YAMLError:
        return None

    # Ensure content is a string
    if not isinstance(content, str):
        content = str(content)

    # Merge: frontmatter fields + content from body
    node_dict = {**frontmatter, "content": content}
    return node_dict


def _read_node_file(path: Path) -> dict[str, Any] | None:
    """Read a single node file (either .md or .json) and return the node dict."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None

    if path.suffix == ".md":
        return _parse_markdown(text)
    # Fallback: JSON
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def get_node(vault_path: Path, node_id: str) -> Optional[dict[str, Any]]:
    """
    Retrieve a single node by ID.

    Scans vault/nodes/**/*.md and **/*.json for a file named <node_id>.*.
    Returns None if not found.
    """
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return None

    # Try .md first, then .json
    for ext in (".md", ".json"):
        for node_file in nodes_dir.rglob(f"{node_id}{ext}"):
            data = _read_node_file(node_file)
            if data is not None:
                return data
    return None


def query_nodes(
    vault_path: Path,
    node_type: Optional[str] = None,
    source: Optional[str] = None,
    min_energy: Optional[int] = None,
    tag: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Query all nodes with optional filters.

    Args:
        vault_path: Root of the vault.
        node_type: Filter by type field (e.g. "Idea", "Pattern").
        source: Filter by source field (e.g. "telegram").
        min_energy: Filter to nodes with energy_level >= min_energy.
        tag: Filter to nodes containing this tag.

    Returns:
        List of matching node dicts. Order is filesystem traversal order.
    """
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return []

    results: list[dict[str, Any]] = []

    # Search both .md and .json files
    for node_file in nodes_dir.rglob("*.md"):
        data = _read_node_file(node_file)
        if data is None:
            continue
        results.append(data)

    # Also include any remaining .json files (migration in progress)
    for node_file in nodes_dir.rglob("*.json"):
        data = _read_node_file(node_file)
        if data is None:
            continue
        results.append(data)

    # Apply filters
    if node_type is not None:
        results = [d for d in results if d.get("type") == node_type]
    if source is not None:
        results = [d for d in results if d.get("source") == source]
    if min_energy is not None:
        results = [d for d in results if d.get("energy_level", 0) >= min_energy]
    if tag is not None:
        results = [d for d in results if tag in d.get("tags", [])]

    return results


def get_recent_nodes(vault_path: Path, n: int = 10) -> list[dict[str, Any]]:
    """
    Return the n most recently created nodes, newest first.

    Args:
        vault_path: Root of the vault.
        n: Number of nodes to return.

    Returns:
        List of node dicts sorted by created_at descending.
    """
    all_nodes = query_nodes(vault_path)
    sorted_nodes = sorted(
        all_nodes,
        key=lambda d: d.get("created_at", ""),
        reverse=True,
    )
    return sorted_nodes[:n]
