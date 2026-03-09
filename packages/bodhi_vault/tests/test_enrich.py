"""Tests for bodhi_vault.enrich module.

Phase 0: tests cover pure-Python concept matching only.
Ollama integration is stubbed — tested in Phase 1 with a live Ollama instance.
"""

import json

import pytest
from bodhi_vault.enrich import match_concepts
from bodhi_vault.write import write_node


def test_match_concepts_finds_soc(concepts_path):
    matches = match_concepts("threshold cascade avalanche tipping point", concepts_path)
    ids = [m["id"] for m in matches]
    assert "self-organized-criticality" in ids


def test_match_concepts_finds_spaced_repetition(concepts_path):
    matches = match_concepts("I want to remember this later, spaced review", concepts_path)
    ids = [m["id"] for m in matches]
    assert "spaced-repetition" in ids


def test_match_concepts_finds_flow(concepts_path):
    matches = match_concepts("deep focus in the zone effortless", concepts_path)
    ids = [m["id"] for m in matches]
    assert "flow-state" in ids


def test_match_concepts_returns_empty_for_no_match(concepts_path):
    matches = match_concepts("xyzzy wumpus groo the wanderer", concepts_path)
    assert matches == []


def test_match_concepts_deduplicates(concepts_path):
    text = "flow flow flow flow state state state"
    matches = match_concepts(text, concepts_path)
    ids = [m["id"] for m in matches]
    assert len(ids) == len(set(ids))


def test_match_concepts_returns_label_and_url(concepts_path):
    matches = match_concepts("metacognition reflection thinking about thinking", concepts_path)
    assert len(matches) > 0
    m = matches[0]
    assert "id" in m
    assert "label" in m
    assert "url" in m
    assert "scholar" in m


def test_enrich_node_updates_related_papers(vault_path, sample_node, schema_path, concepts_path):
    from bodhi_vault.enrich import enrich_node_concepts
    write_node(sample_node, vault_path, schema_path)

    updated = enrich_node_concepts(sample_node["id"], vault_path, schema_path, concepts_path)
    assert updated is True

    from bodhi_vault.read import get_node
    node = get_node(vault_path, sample_node["id"])
    assert node is not None
    assert node.get("related_papers") is not None


def test_enrich_node_idempotent(vault_path, sample_node, schema_path, concepts_path):
    from bodhi_vault.enrich import enrich_node_concepts
    write_node(sample_node, vault_path, schema_path)
    enrich_node_concepts(sample_node["id"], vault_path, schema_path, concepts_path)

    # Second call should return False (already enriched)
    result = enrich_node_concepts(sample_node["id"], vault_path, schema_path, concepts_path)
    assert result is False


def test_enrich_node_force_overrides_idempotency(vault_path, sample_node, schema_path, concepts_path):
    from bodhi_vault.enrich import enrich_node_concepts
    write_node(sample_node, vault_path, schema_path)
    enrich_node_concepts(sample_node["id"], vault_path, schema_path, concepts_path)

    # Force should re-enrich even though already enriched
    result = enrich_node_concepts(
        sample_node["id"], vault_path, schema_path, concepts_path, force=True,
    )
    assert result is True
