"""Tests for bodhi_vault.manifest module."""

import json
from pathlib import Path

import pytest
from bodhi_vault.manifest import ManifestError, compute_hash, update_manifest, verify_manifest


def test_compute_hash_is_sha256():
    h = compute_hash("hello")
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_compute_hash_deterministic():
    assert compute_hash("same") == compute_hash("same")


def test_compute_hash_sensitive_to_content():
    assert compute_hash("a") != compute_hash("b")


def test_update_manifest_creates_file(vault_path, sample_node, tmp_path):
    node_file = tmp_path / "node.json"
    node_file.write_text(json.dumps(sample_node))
    h = compute_hash(sample_node["content"])

    update_manifest(vault_path, sample_node["id"], node_file, h)

    manifest_file = vault_path / "manifest.json"
    assert manifest_file.exists()
    manifest = json.loads(manifest_file.read_text())
    assert sample_node["id"] in manifest
    assert manifest[sample_node["id"]]["hash"] == h


def test_update_manifest_appends(vault_path, sample_node, tmp_path):
    node_file = tmp_path / "node.json"
    node_file.write_text(json.dumps(sample_node))
    h = compute_hash(sample_node["content"])

    update_manifest(vault_path, sample_node["id"], node_file, h)

    second_id = "660e8400-e29b-41d4-a716-446655440001"
    update_manifest(vault_path, second_id, node_file, h)

    manifest = json.loads((vault_path / "manifest.json").read_text())
    assert sample_node["id"] in manifest
    assert second_id in manifest


def test_verify_manifest_passes_on_clean_vault(vault_path, sample_node, schema_path):
    from bodhi_vault.write import write_node
    write_node(sample_node, vault_path, schema_path)
    assert verify_manifest(vault_path) is True


def test_verify_manifest_fails_on_tampered_node(vault_path, sample_node, schema_path):
    from bodhi_vault.write import write_node
    write_node(sample_node, vault_path, schema_path)

    # Tamper: find the written file and corrupt it
    year_month = sample_node["created_at"][:7]
    node_file = vault_path / "nodes" / year_month / f"{sample_node['id']}.json"
    data = json.loads(node_file.read_text())
    data["content"] = "tampered content"
    node_file.write_text(json.dumps(data))

    assert verify_manifest(vault_path) is False
