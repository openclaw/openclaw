"""Tests for bodhi_vault.read module."""

import uuid
from datetime import datetime, timedelta, timezone

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


# --- domain filter (new) ---

def _make_node_with_domain(content, domain, created_at=None):
    n = _make_node(content, created_at=created_at)
    n["domain"] = domain
    return n


def test_query_nodes_filter_by_domain(vault_path, schema_path):
    write_node(_make_node_with_domain("morning run", "fitness"), vault_path, schema_path)
    write_node(_make_node_with_domain("sleep quality", "health"), vault_path, schema_path)
    write_node(_make_node_with_domain("focus session", "cognitive"), vault_path, schema_path)
    results = query_nodes(vault_path, domain="fitness")
    assert len(results) == 1
    assert results[0]["domain"] == "fitness"


def test_query_nodes_domain_returns_all_matching(vault_path, schema_path):
    for i in range(4):
        write_node(_make_node_with_domain(f"wellness {i}", "wellness"), vault_path, schema_path)
    write_node(_make_node_with_domain("fitness one", "fitness"), vault_path, schema_path)
    results = query_nodes(vault_path, domain="wellness")
    assert len(results) == 4


def test_query_nodes_domain_no_match_returns_empty(vault_path, schema_path):
    write_node(_make_node_with_domain("strength training", "fitness"), vault_path, schema_path)
    results = query_nodes(vault_path, domain="mental-health")
    assert results == []


def test_query_nodes_domain_none_returns_all(vault_path, schema_path):
    write_node(_make_node_with_domain("a", "fitness"), vault_path, schema_path)
    write_node(_make_node_with_domain("b", "health"), vault_path, schema_path)
    results = query_nodes(vault_path, domain=None)
    assert len(results) == 2


# --- date-range filter (new) ---

def test_query_nodes_since_filters_earlier(vault_path, schema_path):
    old = _make_node("old thought", created_at="2026-01-01T08:00:00")
    new = _make_node("new thought", created_at="2026-03-15T08:00:00")
    write_node(old, vault_path, schema_path)
    write_node(new, vault_path, schema_path)
    since = datetime(2026, 3, 1)
    results = query_nodes(vault_path, since=since)
    assert len(results) == 1
    assert results[0]["content"] == "new thought"


def test_query_nodes_until_filters_later(vault_path, schema_path):
    old = _make_node("old thought", created_at="2026-01-15T08:00:00")
    new = _make_node("new thought", created_at="2026-03-15T08:00:00")
    write_node(old, vault_path, schema_path)
    write_node(new, vault_path, schema_path)
    until = datetime(2026, 2, 1)
    results = query_nodes(vault_path, until=until)
    assert len(results) == 1
    assert results[0]["content"] == "old thought"


def test_query_nodes_since_and_until_window(vault_path, schema_path):
    dates = [
        ("2026-01-01T08:00:00", "before"),
        ("2026-03-10T08:00:00", "in-window"),
        ("2026-03-12T08:00:00", "in-window-2"),
        ("2026-03-20T08:00:00", "after"),
    ]
    for ts, content in dates:
        write_node(_make_node(content, created_at=ts), vault_path, schema_path)
    since = datetime(2026, 3, 9)
    until = datetime(2026, 3, 14)
    results = query_nodes(vault_path, since=since, until=until)
    assert len(results) == 2
    contents = {r["content"] for r in results}
    assert contents == {"in-window", "in-window-2"}


def test_query_nodes_since_inclusive_boundary(vault_path, schema_path):
    """Nodes at exactly `since` timestamp should be included."""
    boundary = "2026-03-15T00:00:00"
    node = _make_node("boundary node", created_at=boundary)
    write_node(node, vault_path, schema_path)
    since = datetime(2026, 3, 15, 0, 0, 0)
    results = query_nodes(vault_path, since=since)
    assert len(results) == 1


def test_query_nodes_domain_and_since_combined(vault_path, schema_path):
    """domain + date-range filters compose correctly."""
    write_node(
        _make_node_with_domain("old fitness", "fitness", "2026-01-01T00:00:00"),
        vault_path, schema_path
    )
    write_node(
        _make_node_with_domain("new fitness", "fitness", "2026-03-15T00:00:00"),
        vault_path, schema_path
    )
    write_node(
        _make_node_with_domain("new health", "health", "2026-03-15T00:00:00"),
        vault_path, schema_path
    )
    results = query_nodes(vault_path, domain="fitness", since=datetime(2026, 3, 1))
    assert len(results) == 1
    assert results[0]["content"] == "new fitness"


def test_query_nodes_node_missing_created_at_excluded_when_date_filter_set(vault_path, schema_path):
    """Nodes without created_at are skipped when a date filter is active."""
    good = _make_node("has timestamp", created_at="2026-03-15T00:00:00")
    bad = _make_node("no timestamp")
    bad.pop("created_at")
    write_node(good, vault_path, schema_path)
    # Write bad node directly to bypass schema validation
    import json
    node_dir = vault_path / "nodes" / "2026-03"
    node_dir.mkdir(parents=True, exist_ok=True)
    (node_dir / f"{bad['id']}.json").write_text(json.dumps(bad))
    results = query_nodes(vault_path, since=datetime(2026, 3, 1))
    assert len(results) == 1
    assert results[0]["content"] == "has timestamp"
