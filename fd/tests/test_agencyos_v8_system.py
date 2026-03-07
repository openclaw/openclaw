"""Tests for AgencyOS v8: drift healer HealPlan, portal compliance, backup jobs,
system audit log, attribution touchpoints, and new admin endpoints."""

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
def tmp_backup_dir(tmp_path):
    return tmp_path / "backups"


# ── New v8 table existence tests ──


class TestV8Tables:
    def test_system_audit_log_table(self, conn):
        conn.execute(
            "INSERT INTO system_audit_log (id, correlation_id, system, action, target, result, timestamp, created_at) "
            "VALUES ('aud1', 'corr1', 'openclaw', 'heal', 'notion_workspace', 'success', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM system_audit_log WHERE id='aud1'").fetchone()
        assert row["system"] == "openclaw"
        assert row["action"] == "heal"
        assert row["result"] == "success"

    def test_system_audit_log_indexes(self, conn):
        conn.execute(
            "INSERT INTO system_audit_log (id, correlation_id, system, action, target, result, timestamp, created_at) "
            "VALUES ('aud2', 'corr2', 'stripe', 'sync', 'invoices', 'success', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')"
        )
        # Query by correlation_id (index)
        row = conn.execute("SELECT * FROM system_audit_log WHERE correlation_id='corr2'").fetchone()
        assert row is not None
        # Query by system (index)
        rows = conn.execute("SELECT * FROM system_audit_log WHERE system='stripe'").fetchall()
        assert len(rows) == 1

    def test_attribution_touchpoints_v2_table(self, conn):
        conn.execute(
            "INSERT INTO attribution_touchpoints_v2 (id, ghl_contact_id, utm_campaign, confidence, created_at, updated_at) "
            "VALUES ('at1', 'ghl_abc', 'summer_2025', 'high', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM attribution_touchpoints_v2 WHERE id='at1'").fetchone()
        assert row["ghl_contact_id"] == "ghl_abc"
        assert row["utm_campaign"] == "summer_2025"
        assert row["confidence"] == "high"

    def test_backup_runs_table(self, conn):
        conn.execute(
            "INSERT INTO backup_runs (id, backup_type, status, started_at) "
            "VALUES ('bk1', 'sqlite', 'success', '2025-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM backup_runs WHERE id='bk1'").fetchone()
        assert row["backup_type"] == "sqlite"
        assert row["status"] == "success"

    def test_portal_compliance_table(self, conn):
        conn.execute(
            "INSERT INTO portal_compliance (client_id, compliant, created_at, updated_at) "
            "VALUES ('c1', 0, '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM portal_compliance WHERE client_id='c1'").fetchone()
        assert row["compliant"] == 0


# ── Portal Compliance tests ──


class TestPortalCompliance:
    def test_verify_portal_all_sections_present(self, conn):
        from packages.agencyu.notion.portal_compliance import MARKERS, PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        # Simulate page content with all required headings + marker blocks
        begin_notes, end_notes = MARKERS["SYSTEM_NOTES"]
        begin_views, end_views = MARKERS["LINKED_VIEWS"]
        page_content = [
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Overview"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Onboarding Checklist"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Brand Assets"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Active Projects"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Deliverables"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Meetings"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Financial Summary"}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": f"{begin_notes}\ntest\n{end_notes}"}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": f"{begin_views}\ntest\n{end_views}"}]}},
        ]
        result = verifier.verify_portal("client_1", page_content=page_content)
        assert result.compliant is True
        assert len(result.issues) == 0
        assert len(result.missing_sections) == 0
        assert len(result.missing_markers) == 0

    def test_verify_portal_missing_sections(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        # Only provide 2 of 7 required headings (markers also missing = 2 more issues)
        page_content = [
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Overview"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Brand Assets"}]}},
        ]
        result = verifier.verify_portal("client_2", page_content=page_content)
        assert result.compliant is False
        assert len(result.missing_sections) == 5
        assert "Onboarding Checklist" in result.missing_sections
        assert "Deliverables" in result.missing_sections
        assert len(result.missing_markers) == 2

    def test_verify_portal_empty_page(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        result = verifier.verify_portal("client_3", page_content=[])
        assert result.compliant is False
        assert len(result.missing_sections) == 7
        assert len(result.missing_markers) == 2

    def test_verify_portal_case_insensitive(self, conn):
        from packages.agencyu.notion.portal_compliance import MARKERS, PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        begin_notes, end_notes = MARKERS["SYSTEM_NOTES"]
        begin_views, end_views = MARKERS["LINKED_VIEWS"]
        page_content = [
            {"type": "heading_1", "heading_1": {"rich_text": [{"plain_text": "overview"}]}},
            {"type": "heading_3", "heading_3": {"rich_text": [{"plain_text": "ONBOARDING CHECKLIST"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "brand assets"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Active Projects"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Deliverables"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Meetings"}]}},
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Financial Summary"}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": f"{begin_notes}\n\n{end_notes}"}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": f"{begin_views}\n\n{end_views}"}]}},
        ]
        result = verifier.verify_portal("client_4", page_content=page_content)
        assert result.compliant is True

    def test_verify_portal_persists_result(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        verifier.verify_portal("client_5", page_content=[])

        row = conn.execute("SELECT * FROM portal_compliance WHERE client_id='client_5'").fetchone()
        assert row is not None
        assert row["compliant"] == 0
        assert row["missing_sections"] is not None

    def test_heal_portal_simulate(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        result = verifier.heal_portal(
            "client_6", simulate=True,
            missing_sections=["Overview", "Brand Assets"],
            missing_markers=["SYSTEM_NOTES"],
        )
        assert result.simulate is True
        assert result.healed_sections == ["Overview", "Brand Assets"]
        assert result.healed_markers == ["SYSTEM_NOTES"]
        assert len(result.errors) == 0

    def test_heal_portal_no_client_no_notion(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        result = verifier.heal_portal(
            "client_7", simulate=False,
            missing_sections=["Overview"],
            missing_markers=[],
        )
        assert len(result.errors) == 1
        assert "no portal_page_id" in result.errors[0]

    def test_register_portal(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        verifier = PortalComplianceVerifier(conn)
        verifier.register_portal("client_8", "page_abc123")

        row = conn.execute("SELECT * FROM portal_compliance WHERE client_id='client_8'").fetchone()
        assert row["portal_page_id"] == "page_abc123"

    def test_custom_required_headings(self, conn):
        from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

        custom_headings = ["Dashboard", "Reports"]
        verifier = PortalComplianceVerifier(conn, required_headings=custom_headings, markers={})
        page_content = [
            {"type": "heading_2", "heading_2": {"rich_text": [{"plain_text": "Dashboard"}]}},
        ]
        result = verifier.verify_portal("client_9", page_content=page_content)
        assert result.compliant is False
        assert result.missing_sections == ["Reports"]


# ── Backup Jobs tests ──


class TestBackupJobs:
    def test_backup_sqlite(self, conn, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import backup_sqlite

        # Create a temp sqlite file to back up
        with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as f:
            tmp_db = f.name
            # Write some data to make it non-empty
            temp_conn = sqlite3.connect(tmp_db)
            temp_conn.execute("CREATE TABLE test (id TEXT)")
            temp_conn.execute("INSERT INTO test VALUES ('hello')")
            temp_conn.commit()
            temp_conn.close()

        result = backup_sqlite(conn, backup_dir=tmp_backup_dir, source_path=tmp_db)
        assert result.status == "success"
        assert result.checksum is not None
        assert result.size_bytes > 0
        assert Path(result.file_path).exists()

        # Check backup_runs table
        row = conn.execute("SELECT * FROM backup_runs WHERE id=?", (result.backup_id,)).fetchone()
        assert row is not None
        assert row["status"] == "success"

        # Cleanup
        Path(tmp_db).unlink(missing_ok=True)

    def test_backup_sqlite_bad_path(self, conn, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import backup_sqlite

        result = backup_sqlite(conn, backup_dir=tmp_backup_dir, source_path="/nonexistent/db.sqlite")
        assert result.status == "error"
        assert result.error is not None

    def test_backup_trello_metadata(self, conn, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import backup_trello_metadata

        # Insert some test data
        conn.execute(
            "INSERT INTO trello_board_links (trello_board_id, status, created_ts) "
            "VALUES ('board1', 'active', 1000)"
        )
        conn.commit()

        result = backup_trello_metadata(conn, backup_dir=tmp_backup_dir)
        assert result.status == "success"
        assert result.size_bytes > 0

        # Verify JSON content
        content = json.loads(Path(result.file_path).read_text())
        assert "tables" in content
        assert "trello_board_links" in content["tables"]
        assert len(content["tables"]["trello_board_links"]) == 1

    def test_backup_notion_snapshot(self, conn, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import backup_notion_snapshot

        result = backup_notion_snapshot(conn, backup_dir=tmp_backup_dir)
        assert result.status == "success"
        assert result.file_path is not None

    def test_get_backup_history(self, conn, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import backup_trello_metadata, get_backup_history

        backup_trello_metadata(conn, backup_dir=tmp_backup_dir)

        history = get_backup_history(conn)
        assert len(history) >= 1
        assert history[0]["backup_type"] == "trello_metadata"

    def test_get_backup_history_filtered(self, conn, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import (
            backup_notion_snapshot,
            backup_trello_metadata,
            get_backup_history,
        )

        backup_trello_metadata(conn, backup_dir=tmp_backup_dir)
        backup_notion_snapshot(conn, backup_dir=tmp_backup_dir)

        trello_only = get_backup_history(conn, backup_type="trello_metadata")
        assert all(b["backup_type"] == "trello_metadata" for b in trello_only)

    def test_cleanup_old_backups(self, tmp_backup_dir):
        from packages.agencyu.sync.backup_jobs import cleanup_old_backups

        tmp_backup_dir.mkdir(parents=True, exist_ok=True)
        # Create a file and set mtime to old
        old_file = tmp_backup_dir / "old_backup.json"
        old_file.write_text("{}")
        import os
        os.utime(old_file, (0, 0))  # Set to epoch

        removed = cleanup_old_backups(backup_dir=tmp_backup_dir, retention_days=1)
        assert removed == 1
        assert not old_file.exists()


# ── Drift Healer HealPlan tests ──


class TestDriftHealerHealPlan:
    def test_simulate_returns_plan(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer
        from packages.agencyu.notion.manifest_validator import DriftIssue

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        issues = [
            DriftIssue(
                database="clients",
                issue_type="missing_property",
                property_name="health_score",
                details="Missing 'health_score' (expected type: number).",
                healable=True,
            ),
        ]

        plan = healer.simulate(issues)
        assert plan.manifest_hash != ""
        assert plan.generated_at != ""
        assert len(plan.actions) > 0  # At least the property + bootstrap actions

    def test_simulate_blocks_on_wrong_type(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer
        from packages.agencyu.notion.manifest_validator import DriftIssue

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        issues = [
            DriftIssue(
                database="clients",
                issue_type="wrong_type",
                property_name="mrr",
                details="Expected 'number', got 'rich_text'",
                healable=False,
            ),
        ]

        plan = healer.simulate(issues)
        assert plan.ok_to_apply is False
        assert any("wrong_type" in r for r in plan.blocked_reasons)

    def test_simulate_includes_bootstrap_actions(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        plan = healer.simulate([])
        bootstrap_actions = [a for a in plan.actions if a.action_type in ("bootstrap_settings", "bootstrap_views")]
        assert len(bootstrap_actions) > 0

    def test_apply_blocked_by_safety(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        # Default settings: DRY_RUN=True, NOTION_WRITE_ENABLED=False
        plan = healer.apply([])
        assert plan.ok_to_apply is False
        assert len(plan.blocked_reasons) > 0

    def test_bootstrap_settings_record(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        healer._bootstrap_settings_record({
            "template_version": "2.0",
            "os_version": "2.0",
        })

        row = conn.execute("SELECT * FROM system_settings WHERE key='template_version'").fetchone()
        assert row is not None
        assert row["value"] == "2.0"

    def test_bootstrap_views_row(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        healer._bootstrap_views_row({"database_key": "clients", "view_name": "Active Clients"})

        row = conn.execute(
            "SELECT * FROM views_registry WHERE database_key='clients' AND view_name='Active Clients'"
        ).fetchone()
        assert row is not None
        assert row["required"] == 1

    def test_record_audit_entry(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        healer._record_audit_entry(
            correlation_id="test_corr_1",
            system="openclaw",
            action="heal",
            target="notion_workspace",
            result="success",
            details="Test audit entry",
        )

        row = conn.execute("SELECT * FROM system_audit_log WHERE correlation_id='test_corr_1'").fetchone()
        assert row is not None
        assert row["system"] == "openclaw"
        assert row["details"] == "Test audit entry"

    def test_heal_plan_action_dataclass(self):
        from packages.agencyu.notion.drift_healer import HealPlanAction

        action = HealPlanAction(
            action_type="add_property",
            database_key="clients",
            target_id="db_123",
            payload={"properties": {"mrr": {"number": {"format": "number"}}}},
            description="Add property 'mrr' to 'clients'",
        )
        assert action.action_type == "add_property"
        assert action.database_key == "clients"

    def test_heal_plan_dataclass(self):
        from packages.agencyu.notion.drift_healer import HealPlan

        plan = HealPlan(ok_to_apply=True, manifest_hash="abc123", generated_at="2025-01-01")
        assert plan.ok_to_apply is True
        assert plan.actions == []
        assert plan.blocked_reasons == []

    def test_simulate_missing_database(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer
        from packages.agencyu.notion.manifest_validator import DriftIssue

        mock_notion = MagicMock()
        healer = DriftHealer(conn, mock_notion)

        issues = [
            DriftIssue(
                database="clients",
                issue_type="missing_database",
                property_name=None,
                details="Database not found",
                healable=True,
            ),
        ]

        plan = healer.simulate(issues)
        create_actions = [a for a in plan.actions if a.action_type == "create_database"]
        assert len(create_actions) == 1
        assert create_actions[0].database_key == "clients"


# ── Manifest v2.0 governance tests ──


class TestManifestGovernance:
    def test_manifest_has_governance_section(self):
        import yaml

        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        assert "governance" in manifest
        assert manifest["governance"]["schema_lock"]["enabled"] is True
        assert manifest["governance"]["write_lock_default"] is True

    def test_manifest_all_dbs_have_system_managed(self):
        import yaml

        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())

        for db_key, db_spec in manifest["databases"].items():
            props = db_spec.get("properties", {})
            assert "system_managed" in props, f"Database '{db_key}' missing system_managed property"
            assert props["system_managed"]["type"] == "checkbox"

    def test_manifest_has_system_settings_db(self):
        import yaml

        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        assert "system_settings" in manifest["databases"]
        ss = manifest["databases"]["system_settings"]
        assert "template_version" in ss["properties"]
        assert "manifest_hash" in ss["properties"]

    def test_manifest_has_system_audit_log_db(self):
        import yaml

        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        assert "system_audit_log" in manifest["databases"]
        sal = manifest["databases"]["system_audit_log"]
        assert "correlation_id" in sal["properties"]
        assert "system" in sal["properties"]
        assert "action" in sal["properties"]
        assert "ts" in sal["properties"]
        assert "payload_json" in sal["properties"]
        assert "notes" in sal["properties"]
        # Check enhanced result options
        result_opts = sal["properties"]["result"]["options"]
        assert "ok" in result_opts
        assert "blocked" in result_opts
        assert "simulated" in result_opts

    def test_manifest_has_attribution_touchpoints_db(self):
        import yaml

        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        assert "attribution_touchpoints" in manifest["databases"]
        at = manifest["databases"]["attribution_touchpoints"]
        assert "ghl_contact_id" in at["properties"]
        assert "stripe_customer_id" in at["properties"]
        assert "confidence" in at["properties"]

    def test_manifest_views_registry_has_all_db_keys(self):
        import yaml

        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        vr = manifest["databases"]["views_registry"]
        db_key_options = set(vr["properties"]["database_key"]["options"])
        all_db_keys = set(manifest["databases"].keys())

        # Every database should appear as a select option in views_registry
        assert all_db_keys.issubset(db_key_options), f"Missing from views_registry options: {all_db_keys - db_key_options}"
