"""
Tests for bodhi_vault.types module.
Run: uv run pytest tests/test_types.py
"""

from datetime import datetime, timezone

import pytest

from bodhi_vault.types import EdgeType, Node, NodeType


def test_node_type_enum_values():
    assert set(NodeType) == {
        NodeType.IDEA,
        NodeType.PATTERN,
        NodeType.PRACTICE,
        NodeType.DECISION,
        NodeType.SYNTHESIS,
        NodeType.INTEGRATION,
    }


def test_node_type_string_values():
    assert NodeType.IDEA.value == "Idea"
    assert NodeType.SYNTHESIS.value == "Synthesis"


def test_edge_type_enum_values():
    assert EdgeType.SUPPORTS.value == "supports"
    assert EdgeType.CONTRADICTS.value == "contradicts"
    assert EdgeType.PROMOTES.value == "promotes"


def test_node_minimal_construction(sample_node):
    node = Node(
        id=sample_node["id"],
        type=NodeType.IDEA,
        content=sample_node["content"],
        energy_level=sample_node["energy_level"],
        created_at=datetime(2026, 3, 8, 9, 0, 0, tzinfo=timezone.utc),
        source="telegram",
        tags=sample_node["tags"],
    )
    assert node.type == NodeType.IDEA
    assert node.energy_level == 4
    assert node.content_enriched is None
    assert node.related_papers is None


def test_node_with_enriched_fields(sample_node):
    node = Node(
        id=sample_node["id"],
        type=NodeType.IDEA,
        content=sample_node["content"],
        energy_level=4,
        created_at=datetime(2026, 3, 8, 9, 0, 0, tzinfo=timezone.utc),
        source="telegram",
        tags=["soc"],
        content_enriched="Self-organized criticality describes how complex systems...",
        enrichment_model="mistral-nemo:12b",
        related_papers=[{"id": "self-organized-criticality", "label": "Self-Organized Criticality"}],
    )
    assert node.content_enriched is not None
    assert node.enrichment_model == "mistral-nemo:12b"
    assert len(node.related_papers) == 1


def test_node_from_dict(sample_node):
    node = Node.from_dict(sample_node)
    assert node.id == sample_node["id"]
    assert node.type == NodeType.IDEA
    assert node.source == "telegram"


def test_node_to_dict_roundtrip(sample_node):
    node = Node.from_dict(sample_node)
    result = node.to_dict()
    assert result["id"] == sample_node["id"]
    assert result["type"] == "Idea"
    assert result["source"] == "telegram"
    assert "content_enriched" not in result  # Optional fields omitted when None
