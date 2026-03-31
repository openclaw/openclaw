"""
Tests for vault_ingest — reads vault nodes and posts to LightRAG.
No live LightRAG or vault required — uses tmp_path and mocked HTTP.

Run: cd packages/bodhi_vault && pytest tests/test_vault_ingest.py -v
"""
import json
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock


def write_node(vault_path: Path, node_id: str, content: str, domain: str = "wellness"):
    """Helper: write a minimal vault node JSON file."""
    year_month = "2026-03"
    node_dir = vault_path / "nodes" / year_month
    node_dir.mkdir(parents=True, exist_ok=True)
    node = {
        "id": node_id,
        "content": content,
        "content_enriched": f"Expanded: {content}",
        "domain": domain,
        "created_at": "2026-03-17T10:00:00+00:00",
    }
    (node_dir / f"{node_id}.json").write_text(json.dumps(node))
    return node


def test_collect_nodes_finds_all_json(tmp_path):
    """collect_nodes returns all .json files under vault/nodes/."""
    from bodhi_vault.vault_ingest import collect_nodes
    write_node(tmp_path, "n1", "first thought")
    write_node(tmp_path, "n2", "second thought")
    nodes = collect_nodes(tmp_path)
    assert len(nodes) == 2
    assert {n["id"] for n in nodes} == {"n1", "n2"}


def test_collect_nodes_empty_vault(tmp_path):
    """collect_nodes returns [] when vault has no nodes directory."""
    from bodhi_vault.vault_ingest import collect_nodes
    assert collect_nodes(tmp_path) == []


def test_node_to_text_prefers_enriched(tmp_path):
    """node_to_text uses content_enriched when present."""
    from bodhi_vault.vault_ingest import node_to_text
    node = write_node(tmp_path, "n1", "raw")
    text = node_to_text(node)
    assert "Expanded: raw" in text


def test_node_to_text_falls_back_to_raw(tmp_path):
    """node_to_text uses content when content_enriched is absent."""
    from bodhi_vault.vault_ingest import node_to_text
    node = write_node(tmp_path, "n1", "raw thought")
    del node["content_enriched"]
    text = node_to_text(node)
    assert "raw thought" in text


def test_node_to_text_includes_domain(tmp_path):
    """node_to_text includes domain tag for LightRAG context."""
    from bodhi_vault.vault_ingest import node_to_text
    node = write_node(tmp_path, "n1", "thought", domain="fitness")
    assert "fitness" in node_to_text(node)
