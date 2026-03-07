"""Tests for PortalBlocksRegistry, NotionAPI block endpoints, and PortalChildBlockHealer."""
from __future__ import annotations

import sqlite3
from unittest.mock import MagicMock, call

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


# ── PortalBlocksRegistry tests ──


class TestPortalBlocksRegistry:
    def test_ensure_schema_and_upsert(self, conn):
        from packages.agencyu.notion.portal_blocks_registry import (
            PortalBlockRecord,
            PortalBlocksRegistry,
        )

        reg = PortalBlocksRegistry(conn)
        reg.ensure_schema()

        rec = PortalBlockRecord(
            portal_page_id="page_1",
            section_key="start_here",
            container_block_id="block_abc",
        )
        reg.upsert(rec)

        got = reg.get("page_1", "start_here")
        assert got is not None
        assert got.container_block_id == "block_abc"

    def test_upsert_updates_existing(self, conn):
        from packages.agencyu.notion.portal_blocks_registry import (
            PortalBlockRecord,
            PortalBlocksRegistry,
        )

        reg = PortalBlocksRegistry(conn)
        reg.ensure_schema()

        reg.upsert(PortalBlockRecord("page_1", "trello", "block_old"))
        reg.upsert(PortalBlockRecord("page_1", "trello", "block_new"))

        got = reg.get("page_1", "trello")
        assert got.container_block_id == "block_new"

    def test_list_for_page(self, conn):
        from packages.agencyu.notion.portal_blocks_registry import (
            PortalBlockRecord,
            PortalBlocksRegistry,
        )

        reg = PortalBlocksRegistry(conn)
        reg.ensure_schema()

        reg.upsert(PortalBlockRecord("page_1", "start_here", "b1"))
        reg.upsert(PortalBlockRecord("page_1", "trello", "b2"))
        reg.upsert(PortalBlockRecord("page_2", "start_here", "b3"))

        results = reg.list_for_page("page_1")
        assert len(results) == 2

    def test_delete(self, conn):
        from packages.agencyu.notion.portal_blocks_registry import (
            PortalBlockRecord,
            PortalBlocksRegistry,
        )

        reg = PortalBlocksRegistry(conn)
        reg.ensure_schema()

        reg.upsert(PortalBlockRecord("page_1", "finance", "b1"))
        reg.delete("page_1", "finance")
        assert reg.get("page_1", "finance") is None

    def test_get_returns_none_for_missing(self, conn):
        from packages.agencyu.notion.portal_blocks_registry import (
            PortalBlocksRegistry,
        )

        reg = PortalBlocksRegistry(conn)
        reg.ensure_schema()
        assert reg.get("nonexistent", "start_here") is None


# ── NotionAPI block endpoint tests ──


class TestNotionAPIBlockEndpoints:
    def test_retrieve_block(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        api._request = MagicMock(return_value={"id": "blk_1", "type": "callout"})

        result = api.retrieve_block("blk_1")
        assert result["id"] == "blk_1"
        api._request.assert_called_once_with("GET", "/blocks/blk_1")

    def test_delete_block(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        api._request = MagicMock(return_value={"archived": True})

        result = api.delete_block("blk_1")
        assert result["archived"] is True
        api._request.assert_called_once_with("DELETE", "/blocks/blk_1")

    def test_update_block(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        api._request = MagicMock(return_value={"id": "blk_1"})

        payload = {"callout": {"rich_text": [{"type": "text", "text": {"content": "Updated"}}]}}
        result = api.update_block("blk_1", payload)
        assert result["id"] == "blk_1"
        api._request.assert_called_once_with("PATCH", "/blocks/blk_1", payload)

    def test_list_all_block_children_with_limit(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)

        # Simulate paginated response with 5 blocks, limit 3
        blocks = [{"id": f"b{i}", "type": "paragraph"} for i in range(5)]
        api.get_block_children = MagicMock(
            return_value={"results": blocks, "has_more": False}
        )

        result = api.list_all_block_children("page_1", limit=3)
        assert len(result) == 3


# ── PortalChildBlockHealer tests ──


class TestPortalChildBlockHealer:
    def _make_healer(self, conn):
        from packages.agencyu.notion.audit_writer import AuditWriter
        from packages.agencyu.notion.portal_blocks_registry import PortalBlocksRegistry
        from packages.agencyu.notion.portal_child_block_healer import (
            PortalChildBlockHealer,
        )

        reg = PortalBlocksRegistry(conn)
        reg.ensure_schema()

        mock_notion = MagicMock(spec=[
            "list_all_block_children", "append_block_children",
            "update_block", "retrieve_block",
        ])
        audit = AuditWriter(conn)

        healer = PortalChildBlockHealer(mock_notion, audit, reg)
        return healer, mock_notion, reg

    def test_safe_mode_fresh_page_no_writes(self, conn):
        healer, mock_notion, reg = self._make_healer(conn)

        # Empty page (no children)
        mock_notion.list_all_block_children.return_value = []

        ctx = {"client_key": "ck_1", "client_name": "Acme"}
        result = healer.heal_portal_page("page_1", ctx, "cid_1", safe_mode=True)

        assert result["writes"] == 0
        assert any("safe_mode" in w for w in result["warnings"])
        mock_notion.append_block_children.assert_not_called()

    def test_creates_skeleton_on_fresh_page(self, conn):
        healer, mock_notion, reg = self._make_healer(conn)

        # First call: empty page
        # After skeleton creation: return blocks with IDs
        skeleton_blocks = [
            {"id": "b1", "type": "callout", "callout": {"rich_text": [{"plain_text": "Start"}]}},
            {"id": "b2", "type": "divider", "divider": {}},
            {"id": "b3", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Trello & Requests"}]}},
            {"id": "b4", "type": "callout", "callout": {"rich_text": [{"plain_text": "Trello"}]}},
            {"id": "b5", "type": "divider", "divider": {}},
            {"id": "b6", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Dropbox & References"}]}},
            {"id": "b7", "type": "callout", "callout": {"rich_text": [{"plain_text": "Dropbox"}]}},
            {"id": "b8", "type": "divider", "divider": {}},
            {"id": "b9", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Delivery Links"}]}},
            {"id": "b10", "type": "callout", "callout": {"rich_text": [{"plain_text": "Delivery"}]}},
            {"id": "b11", "type": "divider", "divider": {}},
            {"id": "b12", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Invoices & Payments (Mirror)"}]}},
            {"id": "b13", "type": "callout", "callout": {"rich_text": [{"plain_text": "Finance"}]}},
            {"id": "b14", "type": "divider", "divider": {}},
            {"id": "b15", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "System Notes"}]}},
            {"id": "b16", "type": "callout", "callout": {"rich_text": [{"plain_text": "System"}]}},
            {"id": "b17", "type": "divider", "divider": {}},
        ]

        mock_notion.list_all_block_children.side_effect = [
            [],  # first call: empty
            skeleton_blocks,  # second call: after skeleton creation
        ]
        mock_notion.update_block.return_value = {}

        ctx = {"client_key": "ck_1", "client_name": "Acme"}
        result = healer.heal_portal_page("page_1", ctx, "cid_1", safe_mode=False)

        assert result["writes"] >= 1
        mock_notion.append_block_children.assert_called()

        # Registry should have all 6 sections
        recs = reg.list_for_page("page_1")
        registered_keys = {r.section_key for r in recs}
        assert "start_here" in registered_keys
        assert "trello" in registered_keys
        assert "finance" in registered_keys
        assert "system_notes" in registered_keys

    def test_drift_heals_missing_section(self, conn):
        healer, mock_notion, reg = self._make_healer(conn)

        from packages.agencyu.notion.portal_blocks_registry import PortalBlockRecord

        # Pre-register start_here
        reg.upsert(PortalBlockRecord("page_1", "start_here", "b1"))

        # Page has only some headings (missing "Delivery Links")
        existing_children = [
            {"id": "b1", "type": "callout", "callout": {"rich_text": [{"plain_text": "Start"}]}},
            {"id": "h1", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Trello & Requests"}]}},
            {"id": "c1", "type": "callout", "callout": {"rich_text": [{"plain_text": "Trello"}]}},
            {"id": "h2", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Dropbox & References"}]}},
            {"id": "c2", "type": "callout", "callout": {"rich_text": [{"plain_text": "Dropbox"}]}},
        ]

        # After healing, all sections exist
        healed_children = existing_children + [
            {"id": "h3", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Delivery Links"}]}},
            {"id": "c3", "type": "callout", "callout": {"rich_text": [{"plain_text": "Delivery"}]}},
            {"id": "h4", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Invoices & Payments (Mirror)"}]}},
            {"id": "c4", "type": "callout", "callout": {"rich_text": [{"plain_text": "Finance"}]}},
            {"id": "h5", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "System Notes"}]}},
            {"id": "c5", "type": "callout", "callout": {"rich_text": [{"plain_text": "System"}]}},
        ]

        mock_notion.list_all_block_children.side_effect = [
            existing_children,  # initial scan
            healed_children,  # after appending missing sections
        ]
        mock_notion.update_block.return_value = {}

        ctx = {"client_key": "ck_1"}
        result = healer.heal_portal_page("page_1", ctx, "cid_1", safe_mode=False)

        # Should have appended missing sections
        assert result["writes"] >= 1

    def test_safe_mode_reports_missing_sections(self, conn):
        healer, mock_notion, reg = self._make_healer(conn)

        # Page has only start_here callout and one heading
        existing_children = [
            {"id": "b1", "type": "callout", "callout": {"rich_text": [{"plain_text": "Start"}]}},
            {"id": "h1", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Trello & Requests"}]}},
            {"id": "c1", "type": "callout", "callout": {"rich_text": [{"plain_text": "Trello"}]}},
        ]
        mock_notion.list_all_block_children.return_value = existing_children

        ctx = {"client_key": "ck_1"}
        result = healer.heal_portal_page("page_1", ctx, "cid_1", safe_mode=True)

        assert result["writes"] == 0
        # Should warn about missing sections
        missing_warnings = [w for w in result["warnings"] if "safe_mode: would append" in w]
        assert len(missing_warnings) >= 1

    def test_heal_all_clients(self, conn):
        healer, mock_notion, reg = self._make_healer(conn)

        mock_notion.list_all_block_children.return_value = []

        portals = [
            {"portal_page_id": "page_1", "client_key": "ck_1"},
            {"portal_page_id": "page_2", "client_key": "ck_2"},
            {"portal_page_id": None},  # should be skipped
        ]
        result = healer.heal_all_clients(portals, "cid_1", safe_mode=True)
        assert result["writes"] == 0
        # Two valid portals checked
        assert len(result["warnings"]) >= 2

    def test_updates_owned_callout_content(self, conn):
        healer, mock_notion, reg = self._make_healer(conn)

        from packages.agencyu.notion.portal_blocks_registry import PortalBlockRecord

        # Pre-register all sections
        for key in ["start_here", "trello", "dropbox", "delivery", "finance", "system_notes"]:
            reg.upsert(PortalBlockRecord("page_1", key, f"block_{key}"))

        # Page with all headings
        children = [
            {"id": "block_start_here", "type": "callout", "callout": {"rich_text": [{"plain_text": "old"}]}},
            {"id": "h1", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Trello & Requests"}]}},
            {"id": "block_trello", "type": "callout", "callout": {"rich_text": [{"plain_text": "old"}]}},
            {"id": "h2", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Dropbox & References"}]}},
            {"id": "block_dropbox", "type": "callout", "callout": {"rich_text": [{"plain_text": "old"}]}},
            {"id": "h3", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Delivery Links"}]}},
            {"id": "block_delivery", "type": "callout", "callout": {"rich_text": [{"plain_text": "old"}]}},
            {"id": "h4", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Invoices & Payments (Mirror)"}]}},
            {"id": "block_finance", "type": "callout", "callout": {"rich_text": [{"plain_text": "old"}]}},
            {"id": "h5", "type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "System Notes"}]}},
            {"id": "block_system_notes", "type": "callout", "callout": {"rich_text": [{"plain_text": "old"}]}},
        ]
        mock_notion.list_all_block_children.return_value = children
        mock_notion.update_block.return_value = {}

        ctx = {"client_key": "ck_1", "client_name": "Acme", "dropbox_master_url": "https://dropbox.com/acme"}
        result = healer.heal_portal_page("page_1", ctx, "cid_1", safe_mode=False)

        # 6 sections updated
        assert mock_notion.update_block.call_count == 6
        assert result["writes"] == 6

        # Verify callout content includes client_key
        first_update_call = mock_notion.update_block.call_args_list[0]
        callout_text = first_update_call[0][1]["callout"]["rich_text"][0]["text"]["content"]
        assert "ck_1" in callout_text


# ── Orchestrator integration with child-block healer ──


class TestOrchestratorChildBlockHealer:
    def test_child_block_healer_runs(self, conn):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        mock_api = MagicMock(spec=["create_page", "update_page"])

        healer = MagicMock()
        healer.heal_all_clients.return_value = {"writes": 2, "warnings": []}

        portals = [{"portal_page_id": "p1", "client_key": "ck_1"}]

        orch = MirrorOrchestrator(
            conn, mock_api,
            config=OrchestratorConfig(safe_mode=True),
        )
        orch.set_child_block_healer(healer, portals)
        result = orch.run(correlation_id="test_cbh")

        assert result["ok"] is True
        assert "portal_child_block_healer" in result["writers_run"]
        healer.heal_all_clients.assert_called_once()
        # Verify safe_mode was passed
        call_kwargs = healer.heal_all_clients.call_args
        assert call_kwargs.kwargs["safe_mode"] is True
