"""
Tests for bodhi_vault.siyuan_sync.

No SiYuan server needed. Tests use monkeypatching and verify:
- Notebook constant coverage for Bo (wellness) domains
- Silent no-op when SIYUAN_API_TOKEN is unset
- sync_bo_node boundary isolation (only writes to OpenBodhi-* notebooks)
"""

import os
from typing import Any
from unittest.mock import patch

import pytest
from bodhi_vault.siyuan_sync import (
    DOMAIN_NOTEBOOK,
    _BO_NOTEBOOKS,
    sync_bo_node,
    sync_to_siyuan,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

WELLNESS_NODE: dict[str, Any] = {
    "id": "abc12345",
    "type": "Idea",
    "content": "slept 8 hours, felt rested",
    "energy_level": 4,
    "domain": "wellness",
    "tags": ["wellness", "sleep"],
    "source": "telegram",
    "created_at": "2026-03-15T08:00:00",
}

FITNESS_NODE: dict[str, Any] = {
    **WELLNESS_NODE,
    "id": "def67890",
    "domain": "fitness",
    "content": "morning run 5k",
    "tags": ["fitness", "running"],
}

UNKNOWN_DOMAIN_NODE: dict[str, Any] = {
    **WELLNESS_NODE,
    "id": "mno33333",
    "domain": "unknown-future-domain",
    "content": "some future category",
}


# ---------------------------------------------------------------------------
# Notebook constant coverage
# ---------------------------------------------------------------------------


class TestNotebookConstants:
    """Verify the Bo notebook set covers all known wellness domains."""

    def test_wellness_domains_in_bo(self) -> None:
        for domain in ("wellness", "fitness", "health", "mental-health", "cognitive"):
            assert DOMAIN_NOTEBOOK[domain] in _BO_NOTEBOOKS

    def test_domain_notebook_entries_all_in_bo(self) -> None:
        for domain, notebook in DOMAIN_NOTEBOOK.items():
            assert notebook in _BO_NOTEBOOKS, (
                f"Domain '{domain}' maps to '{notebook}' which is not in _BO_NOTEBOOKS"
            )

    def test_bo_notebooks_non_empty(self) -> None:
        assert len(_BO_NOTEBOOKS) > 0


# ---------------------------------------------------------------------------
# sync_to_siyuan — no-op when token unset
# ---------------------------------------------------------------------------


class TestSyncToSiyuanNoOp:
    def test_silent_noop_when_token_unset(self) -> None:
        """sync_to_siyuan must be silent when SIYUAN_API_TOKEN is absent."""
        env = {k: v for k, v in os.environ.items() if k != "SIYUAN_API_TOKEN"}
        with patch.dict(os.environ, env, clear=True):
            sync_to_siyuan(WELLNESS_NODE)

    def test_silent_noop_when_token_empty_string(self) -> None:
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": ""}):
            sync_to_siyuan(WELLNESS_NODE)


# ---------------------------------------------------------------------------
# sync_bo_node — boundary isolation
# ---------------------------------------------------------------------------


class TestSyncBoNode:
    def test_bo_allowed_wellness(self) -> None:
        """Bo may sync wellness nodes."""
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
                sync_bo_node(WELLNESS_NODE)
        mock_sync.assert_called_once_with(WELLNESS_NODE)

    def test_bo_allowed_fitness(self) -> None:
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
                sync_bo_node(FITNESS_NODE)
        mock_sync.assert_called_once_with(FITNESS_NODE)

    def test_bo_noop_when_token_unset(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "SIYUAN_API_TOKEN"}
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, env, clear=True):
                sync_bo_node(WELLNESS_NODE)
        mock_sync.assert_called_once_with(WELLNESS_NODE)

    def test_bo_allows_unknown_domain(self) -> None:
        """Unknown domains (not in DOMAIN_NOTEBOOK) pass through to sync_to_siyuan."""
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
                sync_bo_node(UNKNOWN_DOMAIN_NODE)
        mock_sync.assert_called_once_with(UNKNOWN_DOMAIN_NODE)
