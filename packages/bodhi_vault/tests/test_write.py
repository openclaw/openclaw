"""Tests for bodhi_vault.write module."""

import json
from pathlib import Path

import pytest
from bodhi_vault.manifest import compute_hash, verify_manifest
from bodhi_vault.validate import ValidationError
from bodhi_vault.write import write_node


def test_write_node_creates_file(vault_path, sample_node, schema_path):
    node_id = write_node(sample_node, vault_path, schema_path)
    year_month = sample_node["created_at"][:7]
    node_file = vault_path / "nodes" / year_month / f"{node_id}.json"
    assert node_file.exists()


def test_write_node_returns_id(vault_path, sample_node, schema_path):
    node_id = write_node(sample_node, vault_path, schema_path)
    assert node_id == sample_node["id"]


def test_write_node_content_preserved(vault_path, sample_node, schema_path):
    write_node(sample_node, vault_path, schema_path)
    year_month = sample_node["created_at"][:7]
    node_file = vault_path / "nodes" / year_month / f"{sample_node['id']}.json"
    written = json.loads(node_file.read_text())
    assert written["content"] == sample_node["content"]


def test_write_node_adds_content_hash(vault_path, sample_node, schema_path):
    write_node(sample_node, vault_path, schema_path)
    year_month = sample_node["created_at"][:7]
    node_file = vault_path / "nodes" / year_month / f"{sample_node['id']}.json"
    written = json.loads(node_file.read_text())
    expected_hash = compute_hash(sample_node["content"])
    assert written["content_hash"] == expected_hash


def test_write_node_updates_manifest(vault_path, sample_node, schema_path):
    write_node(sample_node, vault_path, schema_path)
    manifest_file = vault_path / "manifest.json"
    assert manifest_file.exists()
    manifest = json.loads(manifest_file.read_text())
    assert sample_node["id"] in manifest


def test_write_node_manifest_passes_verify(vault_path, sample_node, schema_path):
    write_node(sample_node, vault_path, schema_path)
    assert verify_manifest(vault_path) is True


def test_write_node_invalid_node_raises(vault_path, sample_node, schema_path):
    sample_node["source"] = "discord"
    with pytest.raises(ValidationError):
        write_node(sample_node, vault_path, schema_path)


def test_write_node_invalid_does_not_create_file(vault_path, sample_node, schema_path):
    sample_node["source"] = "discord"
    try:
        write_node(sample_node, vault_path, schema_path)
    except ValidationError:
        pass
    year_month = sample_node["created_at"][:7]
    node_file = vault_path / "nodes" / year_month / f"{sample_node['id']}.json"
    assert not node_file.exists()


def test_write_node_creates_year_month_dir(vault_path, sample_node, schema_path):
    write_node(sample_node, vault_path, schema_path)
    year_month = sample_node["created_at"][:7]
    assert (vault_path / "nodes" / year_month).is_dir()


def test_write_node_with_image_and_domain(vault_path, sample_node, schema_path):
    sample_node["media_type"] = "image"
    sample_node["media_ref"] = "AgACAgIAAxkBAAI"
    sample_node["domain"] = "health"
    node_id = write_node(sample_node, vault_path, schema_path)
    year_month = sample_node["created_at"][:7]
    written = json.loads((vault_path / "nodes" / year_month / f"{node_id}.json").read_text())
    assert written["media_type"] == "image"
    assert written["media_ref"] == "AgACAgIAAxkBAAI"
    assert written["domain"] == "health"


def test_write_node_with_voice_and_domain(vault_path, sample_node, schema_path):
    sample_node["media_type"] = "voice"
    sample_node["media_ref"] = "AwACAgIAAxkBAAI"
    sample_node["domain"] = "mental-health"
    node_id = write_node(sample_node, vault_path, schema_path)
    year_month = sample_node["created_at"][:7]
    written = json.loads((vault_path / "nodes" / year_month / f"{node_id}.json").read_text())
    assert written["media_type"] == "voice"
    assert written["domain"] == "mental-health"


def test_write_node_invalid_domain_raises(vault_path, sample_node, schema_path):
    sample_node["domain"] = "productivity"
    with pytest.raises(ValidationError):
        write_node(sample_node, vault_path, schema_path)
