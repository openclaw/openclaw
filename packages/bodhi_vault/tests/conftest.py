"""
Shared pytest fixtures for bodhi_vault tests.

Fixtures use tmp_path (built-in pytest fixture) for isolated temp directories.
All vault operations in tests write to a temp directory — never the real vault.
"""

import json
from pathlib import Path

import pytest


SCHEMA_DIR = Path(__file__).parent.parent.parent.parent / "vault" / "schema"
SAMPLE_NODE = {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "Idea",
    "content": "self-organized criticality might explain why insight cascades feel sudden",
    "energy_level": 4,
    "created_at": "2026-03-08T09:00:00+00:00",
    "source": "telegram",
    "tags": ["soc", "insight", "cognition"],
}


@pytest.fixture
def vault_path(tmp_path: Path) -> Path:
    """Isolated vault root for each test. Has nodes/ and edges/ subdirectories."""
    (tmp_path / "nodes").mkdir()
    (tmp_path / "edges").mkdir()
    return tmp_path


@pytest.fixture
def schema_path() -> Path:
    """Path to the real nodes.json schema. Tests validate against actual schema."""
    return SCHEMA_DIR / "nodes.json"


@pytest.fixture
def sample_node() -> dict:
    """Minimal valid node dict. Copy before mutating."""
    return dict(SAMPLE_NODE)


@pytest.fixture
def concepts_path() -> Path:
    """Path to concepts.json in the package data directory."""
    return Path(__file__).parent.parent / "src" / "bodhi_vault" / "data" / "concepts.json"
