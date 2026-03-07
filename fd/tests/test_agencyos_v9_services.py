"""Tests for AgencyOS v9: audit logger, snapshot recorder, backup jobs,
Notion audit writer, concrete NotionAPI, and enhanced portal compliance."""

from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


@pytest.fixture()
def tmp_dir(tmp_path):
    return tmp_path / "output"


# ── New table existence tests ──


class TestV9Tables:
    def test_audit_logs_table(self, conn):
        conn.execute(
            "INSERT INTO audit_logs (id, ts, correlation_id, system, action, result) "
            "VALUES ('a1', '2025-01-01T00:00:00Z', 'corr1', 'openclaw', 'heal', 'ok')"
        )
        row = conn.execute("SELECT * FROM audit_logs WHERE id='a1'").fetchone()
        assert row["system"] == "openclaw"
        assert row["result"] == "ok"

    def test_audit_logs_indexes(self, conn):
        conn.execute(
            "INSERT INTO audit_logs (id, ts, correlation_id, system, action, result) "
            "VALUES ('a2', '2025-01-01T00:00:00Z', 'corr2', 'notion', 'verify', 'ok')"
        )
        row = conn.execute("SELECT * FROM audit_logs WHERE correlation_id='corr2'").fetchone()
        assert row is not None
        rows = conn.execute("SELECT * FROM audit_logs WHERE system='notion'").fetchall()
        assert len(rows) == 1

    def test_snapshots_table(self, conn):
        conn.execute(
            "INSERT INTO snapshots (id, ts, snapshot_type, storage_path, status) "
            "VALUES ('s1', '2025-01-01T00:00:00Z', 'openclaw_db', '/backups/db.sqlite', 'ok')"
        )
        row = conn.execute("SELECT * FROM snapshots WHERE id='s1'").fetchone()
        assert row["snapshot_type"] == "openclaw_db"
        assert row["status"] == "ok"

    def test_snapshots_indexes(self, conn):
        conn.execute(
            "INSERT INTO snapshots (id, ts, snapshot_type, storage_path, status) "
            "VALUES ('s2', '2025-01-01T00:00:00Z', 'trello_boards', '/backups/trello.json', 'ok')"
        )
        rows = conn.execute("SELECT * FROM snapshots WHERE snapshot_type='trello_boards'").fetchall()
        assert len(rows) == 1


# ── Audit Logger tests ──


class TestAuditLogger:
    def test_log_basic(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit_id = audit.log(
            correlation_id="corr_test",
            system="openclaw",
            action="heal",
            result="ok",
        )
        assert audit_id.startswith("aud_")

        row = conn.execute("SELECT * FROM audit_logs WHERE id=?", (audit_id,)).fetchone()
        assert row is not None
        assert row["system"] == "openclaw"
        assert row["action"] == "heal"
        assert row["result"] == "ok"

    def test_log_with_payload(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit.log(
            correlation_id="corr_p",
            system="notion",
            action="verify",
            result="ok",
            target="db:clients",
            payload={"issues_found": 3},
            notes="Verification passed",
        )

        row = conn.execute("SELECT * FROM audit_logs WHERE correlation_id='corr_p'").fetchone()
        assert row["target"] == "db:clients"
        assert '"issues_found": 3' in row["payload_json"]
        assert row["notes"] == "Verification passed"

    def test_log_with_stop_reason(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit.log(
            correlation_id="corr_s",
            system="openclaw",
            action="heal_apply",
            result="blocked",
            stop_reason="KILL_SWITCH=true",
        )

        row = conn.execute("SELECT * FROM audit_logs WHERE correlation_id='corr_s'").fetchone()
        assert row["result"] == "blocked"
        assert row["stop_reason"] == "KILL_SWITCH=true"

    def test_get_recent(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit.log(correlation_id="c1", system="openclaw", action="a1", result="ok")
        audit.log(correlation_id="c2", system="notion", action="a2", result="failed")

        recent = audit.get_recent(limit=10)
        assert len(recent) == 2

    def test_get_recent_filtered(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit.log(correlation_id="c1", system="openclaw", action="a1", result="ok")
        audit.log(correlation_id="c2", system="notion", action="a2", result="ok")

        filtered = audit.get_recent(system="notion")
        assert len(filtered) == 1
        assert filtered[0]["system"] == "notion"

    def test_get_by_correlation(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit.log(correlation_id="same_corr", system="openclaw", action="step1", result="ok")
        audit.log(correlation_id="same_corr", system="notion", action="step2", result="ok")
        audit.log(correlation_id="other_corr", system="openclaw", action="unrelated", result="ok")

        entries = audit.get_by_correlation("same_corr")
        assert len(entries) == 2

    def test_get_failures(self, conn):
        from packages.agencyu.services.audit import AuditLogger

        audit = AuditLogger(conn)
        audit.log(correlation_id="c1", system="openclaw", action="a1", result="ok")
        audit.log(correlation_id="c2", system="notion", action="a2", result="failed")

        failures = audit.get_failures()
        assert len(failures) == 1
        assert failures[0]["result"] == "failed"


# ── Snapshot Recorder tests ──


class TestSnapshotRecorder:
    def test_record_basic(self, conn, tmp_dir):
        from packages.agencyu.services.snapshots import SnapshotRecorder

        tmp_dir.mkdir(parents=True, exist_ok=True)
        test_file = tmp_dir / "test.json"
        test_file.write_text('{"test": true}')

        recorder = SnapshotRecorder(conn)
        snap_id = recorder.record(
            snapshot_type="openclaw_db",
            storage_path=str(test_file),
            status="ok",
            scope_key="./data/app.db",
        )
        assert snap_id.startswith("snap_")

        row = conn.execute("SELECT * FROM snapshots WHERE id=?", (snap_id,)).fetchone()
        assert row is not None
        assert row["status"] == "ok"
        assert row["checksum_sha256"] is not None
        assert row["size_bytes"] > 0

    def test_record_failed(self, conn):
        from packages.agencyu.services.snapshots import SnapshotRecorder

        recorder = SnapshotRecorder(conn)
        snap_id = recorder.record(
            snapshot_type="openclaw_db",
            storage_path="/nonexistent/file.db",
            status="failed",
            details="File not found",
        )

        row = conn.execute("SELECT * FROM snapshots WHERE id=?", (snap_id,)).fetchone()
        assert row["status"] == "failed"
        assert row["checksum_sha256"] is None

    def test_get_recent(self, conn, tmp_dir):
        from packages.agencyu.services.snapshots import SnapshotRecorder

        tmp_dir.mkdir(parents=True, exist_ok=True)
        test_file = tmp_dir / "recent.json"
        test_file.write_text("{}")

        recorder = SnapshotRecorder(conn)
        recorder.record(snapshot_type="trello_boards", storage_path=str(test_file), status="ok")
        recorder.record(snapshot_type="notion_db", storage_path=str(test_file), status="ok")

        recent = recorder.get_recent()
        assert len(recent) == 2

    def test_get_recent_filtered(self, conn, tmp_dir):
        from packages.agencyu.services.snapshots import SnapshotRecorder

        tmp_dir.mkdir(parents=True, exist_ok=True)
        test_file = tmp_dir / "filtered.json"
        test_file.write_text("{}")

        recorder = SnapshotRecorder(conn)
        recorder.record(snapshot_type="trello_boards", storage_path=str(test_file), status="ok")
        recorder.record(snapshot_type="notion_db", storage_path=str(test_file), status="ok")

        filtered = recorder.get_recent(snapshot_type="trello_boards")
        assert len(filtered) == 1

    def test_get_latest(self, conn, tmp_dir):
        from packages.agencyu.services.snapshots import SnapshotRecorder

        tmp_dir.mkdir(parents=True, exist_ok=True)
        test_file = tmp_dir / "latest.json"
        test_file.write_text("{}")

        recorder = SnapshotRecorder(conn)
        recorder.record(snapshot_type="openclaw_db", storage_path=str(test_file), status="ok")

        latest = recorder.get_latest("openclaw_db")
        assert latest is not None
        assert latest["snapshot_type"] == "openclaw_db"

        none_latest = recorder.get_latest("nonexistent_type")
        assert none_latest is None


# ── Backup Jobs (services layer) tests ──


class TestBackupJobsV9:
    def test_backup_sqlite_db(self, conn, tmp_dir):
        from packages.agencyu.jobs.backup_openclaw_db import backup_sqlite_db

        # Create temp source DB
        with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as f:
            src_path = f.name
            temp_conn = sqlite3.connect(src_path)
            temp_conn.execute("CREATE TABLE test (id TEXT)")
            temp_conn.execute("INSERT INTO test VALUES ('data')")
            temp_conn.commit()
            temp_conn.close()

        dst = backup_sqlite_db(conn, db_path=src_path, out_dir=str(tmp_dir))
        assert Path(dst).exists()

        # Check audit entry was written
        row = conn.execute("SELECT * FROM audit_logs WHERE action='backup' AND system='openclaw'").fetchone()
        assert row is not None
        assert row["result"] == "ok"

        # Check snapshot was recorded
        snap = conn.execute("SELECT * FROM snapshots WHERE snapshot_type='openclaw_db'").fetchone()
        assert snap is not None
        assert snap["status"] == "ok"

        # Cleanup
        Path(src_path).unlink(missing_ok=True)

    def test_backup_trello_boards(self, conn, tmp_dir):
        from packages.agencyu.jobs.backup_trello_metadata import backup_trello_boards

        # Insert test data
        conn.execute(
            "INSERT INTO trello_board_links (trello_board_id, status, created_ts) "
            "VALUES ('board1', 'active', 1000)"
        )
        conn.commit()

        dst = backup_trello_boards(conn, out_dir=str(tmp_dir))
        assert Path(dst).exists()

        content = json.loads(Path(dst).read_text())
        assert "tables" in content
        assert len(content["tables"]["trello_board_links"]) == 1

        # Check audit + snapshot
        audit_row = conn.execute("SELECT * FROM audit_logs WHERE system='trello' AND action='backup'").fetchone()
        assert audit_row is not None
        snap_row = conn.execute("SELECT * FROM snapshots WHERE snapshot_type='trello_boards'").fetchone()
        assert snap_row is not None

    def test_backup_notion_snapshot(self, conn, tmp_dir):
        from packages.agencyu.jobs.backup_notion_databases import backup_notion_snapshot

        dst = backup_notion_snapshot(conn, out_dir=str(tmp_dir))
        assert Path(dst).exists()

        content = json.loads(Path(dst).read_text())
        assert "tables" in content
        assert "notion_bindings" in content["tables"]


# ── Notion Audit Writer tests ──


class TestNotionAuditWriter:
    def test_write_significant_action(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_abc123"

        writer = NotionAuditWriter(conn, mock_api, audit_log_db_id="db_audit_123")
        page_id = writer.write_entry(
            correlation_id="corr_test",
            system="openclaw",
            action="heal",
            result="ok",
            target="notion_workspace",
        )
        assert page_id == "page_abc123"
        mock_api.create_page.assert_called_once()

    def test_skip_non_significant_action(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter

        mock_api = MagicMock()
        writer = NotionAuditWriter(conn, mock_api, audit_log_db_id="db_audit_123")
        page_id = writer.write_entry(
            correlation_id="corr_test",
            system="openclaw",
            action="some_random_action",
            result="ok",
        )
        assert page_id is None
        mock_api.create_page.assert_not_called()

    def test_skip_without_db_id(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter

        mock_api = MagicMock()
        writer = NotionAuditWriter(conn, mock_api, audit_log_db_id=None)
        page_id = writer.write_entry(
            correlation_id="corr_test",
            system="openclaw",
            action="heal",
            result="ok",
        )
        assert page_id is None

    def test_write_from_local(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_xyz"

        writer = NotionAuditWriter(conn, mock_api, audit_log_db_id="db_audit_123")
        page_id = writer.write_from_local({
            "correlation_id": "corr_local",
            "system": "notion",
            "action": "backup",
            "result": "ok",
            "target": "notion_mirror",
        })
        assert page_id == "page_xyz"

    def test_handles_api_error(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter

        mock_api = MagicMock()
        mock_api.create_page.side_effect = RuntimeError("API error")

        writer = NotionAuditWriter(conn, mock_api, audit_log_db_id="db_audit_123")
        page_id = writer.write_entry(
            correlation_id="corr_err",
            system="openclaw",
            action="verify",
            result="ok",
        )
        assert page_id is None

    def test_resolve_db_from_bindings(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter

        # Add a binding for system_audit_log
        conn.execute(
            "INSERT INTO notion_bindings (id, binding_type, notion_object_id, created_at, updated_at) "
            "VALUES ('nb1', 'system_audit_log', 'db_from_binding', '2025-01-01', '2025-01-01')"
        )
        conn.commit()

        mock_api = MagicMock()
        writer = NotionAuditWriter(conn, mock_api)
        assert writer.audit_log_db_id == "db_from_binding"


# ── NotionAPI concrete client tests ──


class TestNotionAPIConcrete:
    def test_build_property_schema_title(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        schema = api.build_property_schema({"type": "title"})
        assert schema == {"title": {}}

    def test_build_property_schema_select(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        schema = api.build_property_schema({"type": "select", "options": ["A", "B"]})
        assert schema == {"select": {"options": [{"name": "A"}, {"name": "B"}]}}

    def test_build_property_schema_multi_select(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        schema = api.build_property_schema({"type": "multi_select", "options": ["X", "Y"]})
        assert schema == {"multi_select": {"options": [{"name": "X"}, {"name": "Y"}]}}

    def test_build_property_schema_number(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        schema = api.build_property_schema({"type": "number"})
        assert schema == {"number": {"format": "number"}}

    def test_build_property_schema_unsupported(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        with pytest.raises(RuntimeError, match="Unsupported property type"):
            api.build_property_schema({"type": "unknown_type"})

    def test_extract_select_options(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        opts = api.extract_select_options({"type": "select", "options": ["A", "B"]})
        assert opts == ["A", "B"]

    def test_extract_select_options_empty(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        opts = api.extract_select_options({"type": "rich_text"})
        assert opts == []

    def test_extract_relation_target(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        target = api.extract_relation_target_db_id({"type": "relation", "target_db_id": "db_123"})
        assert target == "db_123"

    def test_db_title_parsing(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        title = api._db_title({"title": [{"plain_text": "Clients"}]})
        assert title == "Clients"
        assert api._db_title({}) == ""

    def test_page_title_parsing(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        title = api._page_title({"properties": {"Name": {"type": "title", "title": [{"plain_text": "Primary"}]}}})
        assert title == "Primary"

    def test_select_value_parsing(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        val = api._select_value(
            {"properties": {"Status": {"type": "select", "select": {"name": "ok"}}}},
            "Status",
        )
        assert val == "ok"
        assert api._select_value({"properties": {}}, "Missing") is None

    def test_props_system_settings(self):
        from packages.agencyu.notion.notion_api import NotionAPI

        api = NotionAPI.__new__(NotionAPI)
        props = api._props_system_settings({
            "template_version": "2.0",
            "os_version": "2.0",
            "write_lock": True,
            "manifest_hash": "abc123",
        })
        assert "Template Version" in props
        assert "OS Version" in props
        assert "Write Lock" in props
        assert props["Write Lock"]["checkbox"] is True
        assert "Manifest Hash" in props


# ── Portal compliance marker tests ──


class TestPortalMarkers:
    def test_verify_detects_missing_markers(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn, required_headings=[], markers={
            "TEST_MARKER": ("<!-- BEGIN: TEST -->", "<!-- END: TEST -->"),
        })
        result = verifier.verify_portal("client_m1", page_content=[])
        assert result.compliant is False
        assert "TEST_MARKER" in result.missing_markers

    def test_verify_finds_existing_markers(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn, required_headings=[], markers={
            "TEST_MARKER": ("<!-- BEGIN: TEST -->", "<!-- END: TEST -->"),
        })
        page_content = [
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "<!-- BEGIN: TEST -->\nContent\n<!-- END: TEST -->"}]}},
        ]
        result = verifier.verify_portal("client_m2", page_content=page_content)
        assert result.compliant is True
        assert len(result.missing_markers) == 0

    def test_heal_adds_markers(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn, required_headings=[], markers={
            "NOTES": ("<!-- BEGIN: NOTES -->", "<!-- END: NOTES -->"),
        })
        result = verifier.heal_portal(
            "client_m3", simulate=True,
            missing_sections=[],
            missing_markers=["NOTES"],
        )
        assert result.healed_markers == ["NOTES"]
