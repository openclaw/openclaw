"""Tests for bodhi_vault.validate module."""

import pytest
from bodhi_vault.validate import ValidationError, validate_node


def test_valid_node_passes(sample_node, schema_path):
    validate_node(sample_node, schema_path)  # Must not raise


def test_missing_required_field_raises(sample_node, schema_path):
    del sample_node["content"]
    with pytest.raises(ValidationError, match="content"):
        validate_node(sample_node, schema_path)


def test_invalid_source_raises(sample_node, schema_path):
    sample_node["source"] = "discord"  # Not in enum
    with pytest.raises(ValidationError):
        validate_node(sample_node, schema_path)


def test_telegram_source_is_valid(sample_node, schema_path):
    sample_node["source"] = "telegram"
    validate_node(sample_node, schema_path)  # Must not raise


def test_energy_level_out_of_range_raises(sample_node, schema_path):
    sample_node["energy_level"] = 6
    with pytest.raises(ValidationError):
        validate_node(sample_node, schema_path)


def test_unknown_field_raises(sample_node, schema_path):
    sample_node["secret_field"] = "oops"
    with pytest.raises(ValidationError):
        validate_node(sample_node, schema_path)


def test_content_enriched_optional_valid(sample_node, schema_path):
    sample_node["content_enriched"] = "Expanded version of the thought."
    validate_node(sample_node, schema_path)  # Must not raise


def test_related_papers_structure_valid(sample_node, schema_path):
    sample_node["related_papers"] = [
        {"id": "self-organized-criticality", "label": "Self-Organized Criticality"}
    ]
    validate_node(sample_node, schema_path)


def test_related_papers_missing_required_field_raises(sample_node, schema_path):
    sample_node["related_papers"] = [{"id": "soc"}]  # Missing "label"
    with pytest.raises(ValidationError):
        validate_node(sample_node, schema_path)
