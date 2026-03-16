"""
Tests for bodhi_vault.siyuan_sync.

No SiYuan server needed. Tests use monkeypatching and verify:
- Notebook boundary isolation (sync_bo_node vs sync_qenjin_node)
- Domain → notebook routing
- Silent no-op when SIYUAN_API_TOKEN is unset
- _BO_NOTEBOOKS / _QENJIN_NOTEBOOKS / _TRADER_NOTEBOOKS coverage
"""

import os
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from bodhi_vault.siyuan_sync import (
    DOMAIN_NOTEBOOK,
    _BO_NOTEBOOKS,
    _QENJIN_NOTEBOOKS,
    _TRADER_NOTEBOOKS,
    sync_bo_node,
    sync_qenjin_node,
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

QENJIN_NODE: dict[str, Any] = {
    **WELLNESS_NODE,
    "id": "ghi11111",
    "domain": "qenjin-clients",
    "content": "client onboarded",
    "tags": ["qenjin-clients"],
}

TRADER_NODE: dict[str, Any] = {
    **WELLNESS_NODE,
    "id": "jkl22222",
    "domain": "trader-strategies",
    "content": "TBT divergence setup",
    "tags": ["trader-strategies"],
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
    """Verify the notebook sets are disjoint and complete."""

    def test_bo_qenjin_trader_are_disjoint(self) -> None:
        assert _BO_NOTEBOOKS.isdisjoint(_QENJIN_NOTEBOOKS)
        assert _BO_NOTEBOOKS.isdisjoint(_TRADER_NOTEBOOKS)
        assert _QENJIN_NOTEBOOKS.isdisjoint(_TRADER_NOTEBOOKS)

    def test_domain_notebook_entries_all_known(self) -> None:
        all_known = _BO_NOTEBOOKS | _QENJIN_NOTEBOOKS | _TRADER_NOTEBOOKS
        for domain, notebook in DOMAIN_NOTEBOOK.items():
            assert notebook in all_known, (
                f"Domain '{domain}' maps to '{notebook}' which is not in any agent notebook set"
            )

    def test_wellness_domains_in_bo(self) -> None:
        for domain in ("wellness", "fitness", "health", "mental-health", "cognitive"):
            assert DOMAIN_NOTEBOOK[domain] in _BO_NOTEBOOKS

    def test_qenjin_domains_in_qenjin(self) -> None:
        for domain in ("qenjin-clients", "qenjin-campaigns", "qenjin-research"):
            assert DOMAIN_NOTEBOOK[domain] in _QENJIN_NOTEBOOKS

    def test_trader_domains_in_trader(self) -> None:
        for domain in ("trading", "trader-strategies", "trader-signals"):
            assert DOMAIN_NOTEBOOK[domain] in _TRADER_NOTEBOOKS


# ---------------------------------------------------------------------------
# sync_to_siyuan — no-op when token unset
# ---------------------------------------------------------------------------


class TestSyncToSiyuanNoOp:
    def test_silent_noop_when_token_unset(self) -> None:
        """sync_to_siyuan must be silent when SIYUAN_API_TOKEN is absent."""
        env = {k: v for k, v in os.environ.items() if k != "SIYUAN_API_TOKEN"}
        with patch.dict(os.environ, env, clear=True):
            # Must not raise, must not try to connect
            sync_to_siyuan(WELLNESS_NODE)

    def test_silent_noop_when_token_empty_string(self) -> None:
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": ""}):
            sync_to_siyuan(WELLNESS_NODE)  # must not raise


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

    def test_bo_blocked_qenjin_domain(self) -> None:
        """Bo must NOT sync qenjin-domain nodes."""
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
                sync_bo_node(QENJIN_NODE)
        mock_sync.assert_not_called()

    def test_bo_blocked_trader_domain(self) -> None:
        """Bo must NOT sync trader-domain nodes."""
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
                sync_bo_node(TRADER_NODE)
        mock_sync.assert_not_called()

    def test_bo_noop_when_token_unset(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "SIYUAN_API_TOKEN"}
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, env, clear=True):
                sync_bo_node(WELLNESS_NODE)
        # sync_to_siyuan is called but internally no-ops — this is the correct behavior
        mock_sync.assert_called_once_with(WELLNESS_NODE)

    def test_bo_allows_unknown_domain(self) -> None:
        """Unknown domains (not in DOMAIN_NOTEBOOK) are allowed through to sync_to_siyuan."""
        with patch("bodhi_vault.siyuan_sync.sync_to_siyuan") as mock_sync:
            with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
                sync_bo_node(UNKNOWN_DOMAIN_NODE)
        # Unknown domains have no target → None not in _QENJIN or _TRADER → passes through
        mock_sync.assert_called_once_with(UNKNOWN_DOMAIN_NODE)


# ---------------------------------------------------------------------------
# sync_qenjin_node — boundary isolation
# ---------------------------------------------------------------------------


class TestSyncQenjinNode:
    def test_qenjin_allowed_qenjin_domain(self) -> None:
        """Qenjin may sync qenjin-clients nodes."""
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
            mock_client = MagicMock()
            with patch("bodhi_vault.siyuan_sync._get_client", return_value=mock_client):
                sync_qenjin_node(QENJIN_NODE)
        mock_client.sync_node.assert_called_once()

    def test_qenjin_blocked_wellness_domain(self) -> None:
        """Qenjin must NOT sync wellness nodes."""
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
            mock_client = MagicMock()
            with patch("bodhi_vault.siyuan_sync._get_client", return_value=mock_client):
                sync_qenjin_node(WELLNESS_NODE)
        mock_client.sync_node.assert_not_called()

    def test_qenjin_blocked_trader_domain(self) -> None:
        """Qenjin must NOT sync trader nodes."""
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
            mock_client = MagicMock()
            with patch("bodhi_vault.siyuan_sync._get_client", return_value=mock_client):
                sync_qenjin_node(TRADER_NODE)
        mock_client.sync_node.assert_not_called()

    def test_qenjin_defaults_unknown_domain_to_clients(self) -> None:
        """Unknown domain should be routed to Qenjin-Clients as fallback."""
        unknown = {**QENJIN_NODE, "domain": "some-new-business-domain"}
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
            mock_client = MagicMock()
            with patch("bodhi_vault.siyuan_sync._get_client", return_value=mock_client):
                sync_qenjin_node(unknown)
        mock_client.sync_node.assert_called_once()

    def test_qenjin_noop_when_token_unset(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "SIYUAN_API_TOKEN"}
        with patch.dict(os.environ, env, clear=True):
            mock_client = MagicMock()
            with patch("bodhi_vault.siyuan_sync._get_client", return_value=None):
                sync_qenjin_node(QENJIN_NODE)
        mock_client.sync_node.assert_not_called()

    def test_qenjin_exception_does_not_propagate(self) -> None:
        """SiYuan errors must never crash the caller."""
        with patch.dict(os.environ, {"SIYUAN_API_TOKEN": "fake-token"}):
            mock_client = MagicMock()
            mock_client.sync_node.side_effect = RuntimeError("connection refused")
            with patch("bodhi_vault.siyuan_sync._get_client", return_value=mock_client):
                sync_qenjin_node(QENJIN_NODE)  # must not raise
