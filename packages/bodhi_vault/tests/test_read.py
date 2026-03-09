"""Tests for bodhi_vault.read module."""

import uuid
from datetime import datetime, timezone

import pytest
from bodhi_vault.read import get_node, get_recent_nodes, query_nodes
from bodhi_vault.write import write_node


def _make_node(content, energy=3, source="telegram", node_type="Idea", tags=None, created_at=None):
    return {
        "id": str(uuid.uuid4()),
        "type": node_type,
        "content": content,
        "energy_level": energy,
        "created_at": created_at or "2026-03-08T09:00:00+00:00",
        "source": source,
        "tags": tags or [],
    }


def test_get_node_returns_none_for_missing(vault_path):
    result = get_node(vault_path, "00000000-0000-0000-0000-000000000000")
    assert result is None


def test_get_node_returns_written_node(vault_path, sample_node, schema_path):
    write_node(sample_node, vault_path, schema_path)
    result = get_node(vault_path, sample_node["id"])
    assert result is not None
    assert result["id"] == sample_node["id"]
    assert result["content"] == sample_node["content"]


def test_query_nodes_returns_all(vault_path, schema_path):
    nodes = [_make_node(f"thought {i}") for i in range(3)]
    for n in nodes:
        write_node(n, vault_path, schema_path)
    results = query_nodes(vault_path)
    assert len(results) == 3


def test_query_nodes_filter_by_type(vault_path, schema_path):
    write_node(_make_node("idea", node_type="Idea"), vault_path, schema_path)
    write_node(_make_node("pattern", node_type="Pattern"), vault_path, schema_path)
    results = query_nodes(vault_path, node_type="Idea")
    assert len(results) == 1
    assert results[0]["type"] == "Idea"


def test_query_nodes_filter_by_source(vault_path, schema_path):
    write_node(_make_node("from telegram", source="telegram"), vault_path, schema_path)
    write_node(_make_node("from manual", source="manual"), vault_path, schema_path)
    results = query_nodes(vault_path, source="telegram")
    assert len(results) == 1
    assert results[0]["source"] == "telegram"


def test_query_nodes_filter_by_min_energy(vault_path, schema_path):
    write_node(_make_node("low", energy=1), vault_path, schema_path)
    write_node(_make_node("high", energy=5), vault_path, schema_path)
    results = query_nodes(vault_path, min_energy=4)
    assert len(results) == 1
    assert results[0]["energy_level"] == 5


def test_query_nodes_filter_by_tag(vault_path, schema_path):
    write_node(_make_node("tagged", tags=["soc", "cognition"]), vault_path, schema_path)
    write_node(_make_node("other", tags=["sleep"]), vault_path, schema_path)
    results = query_nodes(vault_path, tag="soc")
    assert len(results) == 1


def test_get_recent_nodes_returns_n(vault_path, schema_path):
    for i in range(5):
        write_node(_make_node(f"node {i}"), vault_path, schema_path)
    results = get_recent_nodes(vault_path, n=3)
    assert len(results) == 3


def test_get_recent_nodes_ordered_by_created_at(vault_path, schema_path):
    early = _make_node("early", created_at="2026-01-01T00:00:00+00:00")
    late = _make_node("late", created_at="2026-03-08T00:00:00+00:00")
    write_node(early, vault_path, schema_path)
    write_node(late, vault_path, schema_path)
    results = get_recent_nodes(vault_path, n=2)
    assert results[0]["content"] == "late"
    assert results[1]["content"] == "early"
