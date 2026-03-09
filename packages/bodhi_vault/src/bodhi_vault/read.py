"""
bodhi_vault.read — Query helpers for the vault.

All reads go through this module. No worker reads JSON files directly.

The vault directory structure:
    vault/
        nodes/
            2026-03/
                <uuid>.json
                <uuid>.json
            2026-04/
                ...
        edges/
            <uuid>.json
        manifest.json

Reads scan the nodes/ subtree. No database — pure filesystem.
For the scale of a personal vault (hundreds to low thousands of nodes),
filesystem scan is fast enough and keeps dependencies minimal.
"""

import json
from pathlib import Path
from typing import Any, Optional


def get_node(vault_path: Path, node_id: str) -> Optional[dict[str, Any]]:
    """
    Retrieve a single node by ID.

    Scans vault/nodes/**/*.json for a file named <node_id>.json.
    Returns None if not found.
    """
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return None

    for node_file in nodes_dir.rglob(f"{node_id}.json"):
        try:
            return json.loads(node_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

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

    for node_file in nodes_dir.rglob("*.json"):
        try:
            data: dict[str, Any] = json.loads(node_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        if node_type is not None and data.get("type") != node_type:
            continue
        if source is not None and data.get("source") != source:
            continue
        if min_energy is not None and data.get("energy_level", 0) < min_energy:
            continue
        if tag is not None and tag not in data.get("tags", []):
            continue

        results.append(data)

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
