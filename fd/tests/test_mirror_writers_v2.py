"""Tests for remaining mirror writers (meetings, assets, SOP, team) and portal block healer."""
from __future__ import annotations

import json
import sqlite3
from unittest.mock import MagicMock, patch

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    """In-memory SQLite with full schema."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


@pytest.fixture()
def mock_notion():
    return MagicMock(spec=[
        "create_page", "update_page", "query_database",
        "get_page", "get_block_children",
    ])


@pytest.fixture()
def mock_audit(conn):
    from packages.agencyu.notion.audit_writer import AuditWriter
    return AuditWriter(conn)


# ── Text-based marker replacement tests ──


class TestReplaceMarkersText:
    def test_replace_existing_markers(self):
        from packages.agencyu.notion.mirror.block_markers import replace_between_markers_text

        body = (
            "Hello\n"
            "[[OPENCLAW:SECTION_A:START]]\n"
            "Old content\n"
            "[[OPENCLAW:SECTION_A:END]]\n"
            "Goodbye"
        )
        result = replace_between_markers_text(body, "SECTION_A", "New content")
        assert "[[OPENCLAW:SECTION_A:START]]" in result
        assert "New content" in result
        assert "Old content" not in result
        assert "Hello" in result
        assert "Goodbye" in result

    def test_append_markers_when_missing(self):
        from packages.agencyu.notion.mirror.block_markers import replace_between_markers_text

        body = "Hello world"
        result = replace_between_markers_text(body, "SECTION_B", "New content")
        assert "[[OPENCLAW:SECTION_B:START]]" in result
        assert "[[OPENCLAW:SECTION_B:END]]" in result
        assert "New content" in result
        assert "Hello world" in result

    def test_preserves_content_outside_markers(self):
        from packages.agencyu.notion.mirror.block_markers import replace_between_markers_text

        body = (
            "Human notes above\n"
            "[[OPENCLAW:X:START]]\nold\n[[OPENCLAW:X:END]]\n"
            "Human notes below"
        )
        result = replace_between_markers_text(body, "X", "new")
        assert "Human notes above" in result
        assert "Human notes below" in result


# ── Meetings writer tests ──


class TestMeetingsWriter:
    def test_safe_mode_no_writes(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_meetings_writer import (
            NotionMeetingsWriter,
        )

        ids = IdentityMapStore(conn)
        writer = NotionMeetingsWriter(
            mock_notion, mock_audit, ids, meetings_db_id="db_meetings"
        )

        mock_ghl = MagicMock()
        mock_ghl.iter_appointments.return_value = [
            {"id": "appt_1", "contact_id": "c1", "title": "Demo Call"},
        ]

        result = writer.mirror(
            {"ghl": mock_ghl}, "cid_1", safe_mode=True, max_writes=100
        )
        assert result["writes"] == 0
        mock_notion.create_page.assert_not_called()

    def test_creates_meeting_in_apply_mode(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_meetings_writer import (
            NotionMeetingsWriter,
        )

        mock_notion.query_database.return_value = {"results": []}
        mock_notion.create_page.return_value = "page_new"

        ids = IdentityMapStore(conn)
        writer = NotionMeetingsWriter(
            mock_notion, mock_audit, ids, meetings_db_id="db_meetings"
        )

        mock_ghl = MagicMock()
        mock_ghl.iter_appointments.return_value = [
            {"id": "appt_1", "contact_id": "c1", "title": "Demo Call", "start_time": "2026-03-01T10:00:00Z"},
        ]

        result = writer.mirror(
            {"ghl": mock_ghl}, "cid_1", safe_mode=False, max_writes=100
        )
        assert result["writes"] == 1
        mock_notion.create_page.assert_called_once()

    def test_no_db_id_returns_warning(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_meetings_writer import (
            NotionMeetingsWriter,
        )

        writer = NotionMeetingsWriter(mock_notion, mock_audit, IdentityMapStore(conn))
        result = writer.mirror({}, "cid_1")
        assert result["writes"] == 0
        assert any("no meetings_db_id" in w for w in result["warnings"])


# ── Assets writer tests ──


class TestAssetsWriter:
    def test_safe_mode_no_writes(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_assets_writer import (
            NotionAssetsWriter,
        )

        ids = IdentityMapStore(conn)
        writer = NotionAssetsWriter(mock_notion, mock_audit, ids, assets_db_id="db_assets")

        mock_ghl = MagicMock()
        mock_ghl.list_client_contacts.return_value = [
            {
                "id": "c1",
                "custom_fields": {
                    "client_key": "ck_1",
                    "dropbox_master_folder_url": "https://dropbox.com/folder",
                },
            },
        ]

        result = writer.mirror(
            {"ghl": mock_ghl}, "cid_1", safe_mode=True, max_writes=100
        )
        assert result["writes"] == 0
        mock_notion.create_page.assert_not_called()

    def test_creates_asset_in_apply_mode(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.writers.notion_assets_writer import (
            NotionAssetsWriter,
        )

        mock_notion.query_database.return_value = {"results": []}
        mock_notion.create_page.return_value = "page_new"

        ids = IdentityMapStore(conn)
        writer = NotionAssetsWriter(mock_notion, mock_audit, ids, assets_db_id="db_assets")

        mock_ghl = MagicMock()
        mock_ghl.list_client_contacts.return_value = [
            {
                "id": "c1",
                "custom_fields": {
                    "client_key": "ck_1",
                    "dropbox_master_folder_url": "https://dropbox.com/folder",
                    "brand_assets_url": "https://brand.kit/assets",
                },
            },
        ]

        result = writer.mirror(
            {"ghl": mock_ghl}, "cid_1", safe_mode=False, max_writes=100
        )
        assert result["writes"] == 2  # dropbox + brand_assets
        assert mock_notion.create_page.call_count == 2


# ── SOP writer tests ──


class TestSOPWriter:
    def test_safe_mode_no_writes(self, mock_notion, mock_audit):
        from packages.agencyu.notion.mirror.writers.notion_sop_writer import (
            NotionSOPWriter,
        )

        writer = NotionSOPWriter(
            mock_notion, mock_audit, sop_db_id="db_sop",
            required_sops=[{"key": "onboarding", "title": "Client Onboarding"}],
        )

        result = writer.mirror({}, "cid_1", safe_mode=True)
        assert result["writes"] == 0

    def test_seeds_missing_sop_in_apply_mode(self, mock_notion, mock_audit):
        from packages.agencyu.notion.mirror.writers.notion_sop_writer import (
            NotionSOPWriter,
        )

        mock_notion.query_database.return_value = {"results": []}
        mock_notion.create_page.return_value = "page_new"

        writer = NotionSOPWriter(
            mock_notion, mock_audit, sop_db_id="db_sop",
            required_sops=[{"key": "onboarding", "title": "Client Onboarding", "category": "Operations"}],
        )

        result = writer.mirror({}, "cid_1", safe_mode=False)
        assert result["writes"] == 1
        mock_notion.create_page.assert_called_once()

    def test_no_required_sops_ok(self, mock_notion, mock_audit):
        from packages.agencyu.notion.mirror.writers.notion_sop_writer import (
            NotionSOPWriter,
        )

        writer = NotionSOPWriter(mock_notion, mock_audit, sop_db_id="db_sop")
        result = writer.mirror({}, "cid_1")
        assert result["writes"] == 0
        assert any("no required_sops" in w for w in result["warnings"])


# ── Team writer tests ──


class TestTeamWriter:
    def test_safe_mode_no_writes(self, mock_notion, mock_audit):
        from packages.agencyu.notion.mirror.writers.notion_team_writer import (
            NotionTeamWriter,
        )

        writer = NotionTeamWriter(mock_notion, mock_audit, team_db_id="db_team")
        result = writer.mirror(
            {"team_roster": [{"email": "da@fd.co", "name": "DA"}]},
            "cid_1", safe_mode=True,
        )
        assert result["writes"] == 0

    def test_seeds_member_in_apply_mode(self, mock_notion, mock_audit):
        from packages.agencyu.notion.mirror.writers.notion_team_writer import (
            NotionTeamWriter,
        )

        mock_notion.query_database.return_value = {"results": []}
        mock_notion.create_page.return_value = "page_new"

        writer = NotionTeamWriter(mock_notion, mock_audit, team_db_id="db_team")
        result = writer.mirror(
            {"team_roster": [{"email": "da@fd.co", "name": "DA", "role": "Lead"}]},
            "cid_1", safe_mode=False,
        )
        assert result["writes"] == 1
        mock_notion.create_page.assert_called_once()

    def test_no_roster_returns_warning(self, mock_notion, mock_audit):
        from packages.agencyu.notion.mirror.writers.notion_team_writer import (
            NotionTeamWriter,
        )

        writer = NotionTeamWriter(mock_notion, mock_audit, team_db_id="db_team")
        result = writer.mirror({}, "cid_1")
        assert result["writes"] == 0
        assert any("no team_roster" in w for w in result["warnings"])


# ── Portal block healer tests ──


class TestPortalBlockHealer:
    def test_safe_mode_no_writes(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.portal_block_healer import (
            PortalBlockHealer,
        )

        # Mock query to return a client row with client_key and Notes
        mock_notion.query_database.return_value = {
            "results": [
                {
                    "id": "page_1",
                    "properties": {
                        "client_key": {
                            "rich_text": [{"plain_text": "ck_test"}],
                        },
                        "Notes": {
                            "rich_text": [{"plain_text": ""}],
                        },
                    },
                },
            ]
        }

        healer = PortalBlockHealer(
            mock_notion, mock_audit, IdentityMapStore(conn),
            clients_db_id="db_clients",
        )
        result = healer.heal_all_clients({}, "cid_1", safe_mode=True)
        assert result["writes"] == 0
        mock_notion.update_page.assert_not_called()

    def test_heals_portal_in_apply_mode(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.portal_block_healer import (
            PortalBlockHealer,
        )

        mock_notion.query_database.return_value = {
            "results": [
                {
                    "id": "page_1",
                    "properties": {
                        "client_key": {
                            "rich_text": [{"plain_text": "ck_test"}],
                        },
                        "Notes": {
                            "rich_text": [{"plain_text": "Existing notes"}],
                        },
                    },
                },
            ]
        }

        healer = PortalBlockHealer(
            mock_notion, mock_audit, IdentityMapStore(conn),
            clients_db_id="db_clients",
        )
        result = healer.heal_all_clients({}, "cid_1", safe_mode=False)
        assert result["writes"] == 1
        mock_notion.update_page.assert_called_once()

        # Verify the updated Notes contain all marker sections
        call_args = mock_notion.update_page.call_args
        updated_props = call_args[0][1]
        notes_text = updated_props["Notes"]["rich_text"][0]["text"]["content"]
        assert "[[OPENCLAW:PORTAL_START_HERE:START]]" in notes_text
        assert "[[OPENCLAW:PORTAL_PROJECTS_MIRROR:START]]" in notes_text
        assert "[[OPENCLAW:PORTAL_FINANCE_MIRROR:START]]" in notes_text
        assert "[[OPENCLAW:PORTAL_DROPBOX_MASTER:START]]" in notes_text
        assert "[[OPENCLAW:PORTAL_DELIVERY_LINKS:START]]" in notes_text
        assert "[[OPENCLAW:PORTAL_LINKS_JSON:START]]" in notes_text
        assert "[[OPENCLAW:PORTAL_SYSTEM_NOTES:START]]" in notes_text
        assert "Existing notes" in notes_text

    def test_no_clients_db_returns_warning(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.portal_block_healer import (
            PortalBlockHealer,
        )

        healer = PortalBlockHealer(
            mock_notion, mock_audit, IdentityMapStore(conn),
        )
        result = healer.heal_all_clients({}, "cid_1")
        assert result["writes"] == 0
        assert any("no clients_db_id" in w for w in result["warnings"])

    def test_skips_client_without_key(self, mock_notion, mock_audit, conn):
        from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
        from packages.agencyu.notion.mirror.portal_block_healer import (
            PortalBlockHealer,
        )

        mock_notion.query_database.return_value = {
            "results": [
                {
                    "id": "page_1",
                    "properties": {
                        "client_key": {"rich_text": []},
                        "Notes": {"rich_text": [{"plain_text": "notes"}]},
                    },
                },
            ]
        }

        healer = PortalBlockHealer(
            mock_notion, mock_audit, IdentityMapStore(conn),
            clients_db_id="db_clients",
        )
        result = healer.heal_all_clients({}, "cid_1", safe_mode=False)
        assert result["writes"] == 0


# ── Orchestrator integration with source writers + portal healer ──


class TestOrchestratorWithSourceWriters:
    def test_source_writers_run_after_entity_writers(self, conn):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        mock_api = MagicMock(spec=["create_page", "update_page"])

        # Mock source writer
        sw = MagicMock()
        sw.writer_name = "meetings"
        sw.mirror.return_value = {"writes": 0, "warnings": []}

        orch = MirrorOrchestrator(
            conn, mock_api,
            config=OrchestratorConfig(safe_mode=True),
        )
        orch.register_source_writer(sw)
        result = orch.run(correlation_id="test_sw")

        assert result["ok"] is True
        assert "meetings" in result["writers_run"]
        sw.mirror.assert_called_once()

    def test_portal_healer_runs_after_writers(self, conn):
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        mock_api = MagicMock(spec=["create_page", "update_page"])

        healer = MagicMock()
        healer.heal_all_clients.return_value = {"writes": 0, "warnings": []}

        orch = MirrorOrchestrator(
            conn, mock_api,
            config=OrchestratorConfig(safe_mode=True),
        )
        orch.set_portal_healer(healer)
        result = orch.run(correlation_id="test_ph")

        assert result["ok"] is True
        assert "portal_healer" in result["writers_run"]
        healer.heal_all_clients.assert_called_once()
