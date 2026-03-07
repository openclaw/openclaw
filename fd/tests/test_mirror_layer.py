"""Tests for the Notion mirror layer: block markers, identity map, orchestrator, writers."""
from __future__ import annotations

import json
import sqlite3
from unittest.mock import MagicMock

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    """In-memory SQLite with full schema."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


# ── Block markers tests ──


class TestBlockMarkers:
    def test_find_marker_regions(self):
        from packages.agencyu.notion.mirror.block_markers import find_marker_regions

        blocks = [
            _para("Some intro text"),
            _para("[[OPENCLAW:financial_summary:START]]"),
            _para("Old revenue data"),
            _para("[[OPENCLAW:financial_summary:END]]"),
            _para("Footer text"),
        ]
        regions = find_marker_regions(blocks)
        assert len(regions) == 1
        assert regions[0].key == "financial_summary"
        assert regions[0].start_index == 1
        assert regions[0].end_index == 3

    def test_replace_between_markers(self):
        from packages.agencyu.notion.mirror.block_markers import replace_between_markers

        blocks = [
            _para("Intro"),
            _para("[[OPENCLAW:tasks:START]]"),
            _para("Old task 1"),
            _para("Old task 2"),
            _para("[[OPENCLAW:tasks:END]]"),
            _para("Footer"),
        ]
        new_content = [_para("New task A"), _para("New task B")]
        result = replace_between_markers(blocks, "tasks", new_content)

        assert len(result) == 6
        assert _text(result[0]) == "Intro"
        assert _text(result[1]) == "[[OPENCLAW:tasks:START]]"
        assert _text(result[2]) == "New task A"
        assert _text(result[3]) == "New task B"
        assert _text(result[4]) == "[[OPENCLAW:tasks:END]]"
        assert _text(result[5]) == "Footer"

    def test_replace_no_matching_key_returns_unchanged(self):
        from packages.agencyu.notion.mirror.block_markers import replace_between_markers

        blocks = [_para("Hello")]
        result = replace_between_markers(blocks, "nonexistent", [_para("X")])
        assert len(result) == 1
        assert _text(result[0]) == "Hello"

    def test_wrap_with_markers(self):
        from packages.agencyu.notion.mirror.block_markers import wrap_with_markers

        children = [_para("Content")]
        wrapped = wrap_with_markers("overview", children)
        assert len(wrapped) == 3
        assert "[[OPENCLAW:overview:START]]" in _text(wrapped[0])
        assert _text(wrapped[1]) == "Content"
        assert "[[OPENCLAW:overview:END]]" in _text(wrapped[2])

    def test_multiple_regions(self):
        from packages.agencyu.notion.mirror.block_markers import find_marker_regions

        blocks = [
            _para("[[OPENCLAW:a:START]]"),
            _para("A content"),
            _para("[[OPENCLAW:a:END]]"),
            _para("gap"),
            _para("[[OPENCLAW:b:START]]"),
            _para("B content"),
            _para("[[OPENCLAW:b:END]]"),
        ]
        regions = find_marker_regions(blocks)
        assert len(regions) == 2
        assert regions[0].key == "a"
        assert regions[1].key == "b"


# ── Page blocks tests ──


class TestPageBlocks:
    def test_heading_1(self):
        from packages.agencyu.notion.mirror.page_blocks import heading_1

        block = heading_1("Title")
        assert block["type"] == "heading_1"
        assert block["heading_1"]["rich_text"][0]["text"]["content"] == "Title"

    def test_paragraph(self):
        from packages.agencyu.notion.mirror.page_blocks import paragraph

        block = paragraph("Hello world")
        assert block["type"] == "paragraph"

    def test_callout_with_icon(self):
        from packages.agencyu.notion.mirror.page_blocks import callout

        block = callout("Warning!", icon="warning")
        assert block["type"] == "callout"
        assert block["callout"]["icon"]["emoji"] == "\u26a0\ufe0f"

    def test_divider(self):
        from packages.agencyu.notion.mirror.page_blocks import divider

        block = divider()
        assert block["type"] == "divider"

    def test_kv_row(self):
        from packages.agencyu.notion.mirror.page_blocks import kv_row

        block = kv_row("Status", "Active")
        assert "Status: Active" in block["bulleted_list_item"]["rich_text"][0]["text"]["content"]


# ── Identity map tests ──


class TestIdentityMap:
    def test_upsert_and_resolve(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        store.upsert_mapping(
            domain="client",
            external_id="c_123",
            notion_page_id="np_abc",
            ghl_contact_id="ghl_456",
        )

        assert store.resolve_notion_page_id(domain="client", external_id="c_123") == "np_abc"
        assert store.resolve_by_ghl_contact("ghl_456") == "np_abc"

    def test_resolve_chain_priority(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        store.upsert_mapping(
            domain="client",
            external_id="c_1",
            notion_page_id="page_1",
            ghl_contact_id="ghl_1",
        )

        # domain+external_id takes priority
        result = store.resolve_chain(
            domain="client",
            external_id="c_1",
            ghl_contact_id="ghl_1",
        )
        assert result == "page_1"

    def test_resolve_chain_fallback_to_ghl(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        store.upsert_mapping(
            domain="client",
            external_id="c_1",
            notion_page_id="page_1",
            ghl_contact_id="ghl_1",
        )

        # No domain match, falls back to GHL
        result = store.resolve_chain(ghl_contact_id="ghl_1")
        assert result == "page_1"

    def test_resolve_returns_none_when_not_found(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        assert store.resolve_chain(ghl_contact_id="nonexistent") is None

    def test_upsert_canonical_entity(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        eid, is_new = store.upsert_canonical_entity(
            entity_type="client",
            canonical_key="c_1",
            data={"name": "Acme Corp"},
        )
        assert is_new is True
        assert eid.startswith("ce_")

        # Second call with same data → not new
        eid2, is_new2 = store.upsert_canonical_entity(
            entity_type="client",
            canonical_key="c_1",
            data={"name": "Acme Corp"},
        )
        assert eid2 == eid
        assert is_new2 is False

    def test_upsert_canonical_entity_detects_change(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        eid, _ = store.upsert_canonical_entity(
            entity_type="client",
            canonical_key="c_1",
            data={"name": "Acme Corp"},
        )

        # Update data → still same ID, but hash should be updated
        eid2, is_new = store.upsert_canonical_entity(
            entity_type="client",
            canonical_key="c_1",
            data={"name": "Acme Corp v2"},
        )
        assert eid2 == eid
        assert is_new is False

    def test_link_source(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        eid, _ = store.upsert_canonical_entity(
            entity_type="client",
            canonical_key="c_1",
            data={"name": "Test"},
        )
        store.link_source(
            entity_id=eid,
            source_system="ghl",
            source_type="contact",
            source_id="ghl_123",
        )

        row = conn.execute(
            "SELECT * FROM entity_mappings WHERE source_id='ghl_123'"
        ).fetchone()
        assert row is not None
        assert row["entity_id"] == eid

    def test_mirror_state(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore

        store = IdentityMapStore(conn)
        eid, _ = store.upsert_canonical_entity(
            entity_type="client",
            canonical_key="c_1",
            data={"name": "Test"},
        )
        store.upsert_mirror_state(
            entity_id=eid,
            database_key="clients",
            notion_page_id="np_1",
            content_hash="abc123",
        )

        state = store.get_mirror_state(eid)
        assert state is not None
        assert state["notion_page_id"] == "np_1"
        assert state["sync_health"] == "ok"


# ── Orchestrator tests ──


class TestMirrorOrchestrator:
    def test_safe_mode_produces_no_writes(self, conn):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        # Seed a canonical entity
        _seed_client(conn, "c_1", {"name": "Test Client"})

        mock_api = MagicMock(spec=["create_page", "update_page"])

        from packages.agencyu.notion.mirror.writers.notion_clients_writer import (
            NotionClientsWriter,
        )

        writer = NotionClientsWriter(conn, notion_db_id="db_123")

        orch = MirrorOrchestrator(
            conn,
            mock_api,
            config=OrchestratorConfig(safe_mode=True),
        )
        orch.register(writer)
        result = orch.run(correlation_id="test_safe")

        assert result["ok"] is True
        assert result["safe_mode"] is True
        assert result["skipped"] >= 1
        mock_api.create_page.assert_not_called()
        mock_api.update_page.assert_not_called()

    def test_blocked_by_kill_switch(self, conn, monkeypatch):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        monkeypatch.setattr("packages.common.config.settings.KILL_SWITCH", True)

        mock_api = MagicMock()
        orch = MirrorOrchestrator(
            conn, mock_api,
            config=OrchestratorConfig(safe_mode=False),
        )
        result = orch.run()

        assert result["ok"] is False
        assert "kill_switch" in result["stop_reason"]

    def test_action_cap_limits_run(self, conn):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        # Seed many entities
        for i in range(20):
            _seed_client(conn, f"c_{i}", {"name": f"Client {i}"})

        mock_api = MagicMock(spec=["create_page", "update_page"])

        from packages.agencyu.notion.mirror.writers.notion_clients_writer import (
            NotionClientsWriter,
        )

        writer = NotionClientsWriter(conn, notion_db_id="db_123")

        orch = MirrorOrchestrator(
            conn,
            mock_api,
            config=OrchestratorConfig(safe_mode=True, max_actions=5),
        )
        orch.register(writer)
        result = orch.run()

        assert result["ok"] is True
        assert result["actions"] <= 5

    def test_sync_run_recorded(self, conn):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        mock_api = MagicMock(spec=["create_page", "update_page"])
        orch = MirrorOrchestrator(
            conn, mock_api,
            config=OrchestratorConfig(safe_mode=True),
        )
        result = orch.run()

        run_id = result["run_id"]
        row = conn.execute(
            "SELECT * FROM sync_runs WHERE id=?", (run_id,)
        ).fetchone()
        assert row is not None
        assert row["status"] == "completed"


# ── Writer tests ──


class TestClientsWriter:
    def test_collect_pending_finds_new_entities(self, conn):
        from packages.agencyu.notion.mirror.writers.notion_clients_writer import (
            NotionClientsWriter,
        )

        _seed_client(conn, "c_1", {"name": "Test"})
        writer = NotionClientsWriter(conn)
        pending = writer.collect_pending()
        assert len(pending) == 1

    def test_mirror_one_safe_mode(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_clients_writer import (
            NotionClientsWriter,
        )

        _seed_client(conn, "c_1", {"name": "Acme", "ghl_contact_id": "ghl_1"})
        writer = NotionClientsWriter(conn, notion_db_id="db_1")

        pending = writer.collect_pending()
        mock_api = MagicMock()
        identity = IdentityMapStore(conn)

        result = writer.mirror_one(
            pending[0],
            safe_mode=True,
            notion_api=mock_api,
            identity_store=identity,
        )
        assert result["dry_run"] is True
        assert result["action"] == "create"


class TestTasksWriter:
    def test_collect_pending(self, conn):
        from packages.agencyu.notion.mirror.writers.notion_tasks_writer import (
            NotionTasksWriter,
        )

        _seed_entity(conn, "task", "t_1", {"title": "Fix bug", "status": "open"})
        writer = NotionTasksWriter(conn)
        pending = writer.collect_pending()
        assert len(pending) == 1

    def test_mirror_one_safe_mode(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_tasks_writer import (
            NotionTasksWriter,
        )

        _seed_entity(conn, "task", "t_1", {"title": "Deploy", "trello_card_id": "tc_1"})
        writer = NotionTasksWriter(conn, notion_db_id="db_tasks")

        pending = writer.collect_pending()
        result = writer.mirror_one(
            pending[0],
            safe_mode=True,
            notion_api=MagicMock(),
            identity_store=IdentityMapStore(conn),
        )
        assert result["dry_run"] is True


class TestFinanceWriter:
    def test_collect_pending_invoices_and_expenses(self, conn):
        from packages.agencyu.notion.mirror.writers.notion_finance_writer import (
            NotionFinanceWriter,
        )

        _seed_entity(conn, "invoice", "inv_1", {"description": "Jan payment", "amount_cents": 50000})
        _seed_entity(conn, "expense", "exp_1", {"vendor": "AWS", "amount_cents": 10000})
        writer = NotionFinanceWriter(conn)
        pending = writer.collect_pending()
        assert len(pending) == 2

    def test_mirror_invoice_safe_mode(self, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_finance_writer import (
            NotionFinanceWriter,
        )

        _seed_entity(conn, "invoice", "inv_1", {"description": "Payment", "amount_cents": 50000})
        writer = NotionFinanceWriter(conn, invoices_db_id="db_inv")

        pending = writer.collect_pending()
        result = writer.mirror_one(
            pending[0],
            safe_mode=True,
            notion_api=MagicMock(),
            identity_store=IdentityMapStore(conn),
        )
        assert result["dry_run"] is True


# ── Helpers ──


def _para(text: str) -> dict:
    return {
        "type": "paragraph",
        "paragraph": {
            "rich_text": [{"type": "text", "plain_text": text, "text": {"content": text}}],
        },
    }


def _text(block: dict) -> str:
    btype = block.get("type", "")
    rt = block.get(btype, {}).get("rich_text", [{}])
    if not rt:
        return ""
    t = rt[0]
    return t.get("plain_text") or t.get("text", {}).get("content", "")


def _seed_client(conn: sqlite3.Connection, key: str, data: dict) -> str:
    return _seed_entity(conn, "client", key, data)


def _seed_entity(conn: sqlite3.Connection, entity_type: str, key: str, data: dict) -> str:
    import hashlib

    from packages.common.clock import utc_now_iso
    from packages.common.ids import new_id

    now = utc_now_iso()
    data_json = json.dumps(data, sort_keys=True)
    content_hash = hashlib.sha256(data_json.encode()).hexdigest()[:16]
    eid = new_id("ce")
    conn.execute(
        """INSERT INTO canonical_entities
           (id, entity_type, canonical_key, data_json, content_hash, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (eid, entity_type, key, data_json, content_hash, now, now, now),
    )
    conn.commit()
    return eid
