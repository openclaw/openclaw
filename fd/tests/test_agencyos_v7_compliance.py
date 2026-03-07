"""Tests for AgencyOS v7: compliance verifier, views registry, rate limiter,
expanded manifest (v2.0), and new execution backbone DB tables."""

from __future__ import annotations

import sqlite3
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


# ── New table existence tests ──


class TestV7Tables:
    def test_outcomes_table(self, conn):
        conn.execute(
            "INSERT INTO outcomes (id, client_id, name, status, created_at, updated_at) "
            "VALUES ('o1', 'c1', 'Grow IG', 'In Progress', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM outcomes WHERE id='o1'").fetchone()
        assert row["name"] == "Grow IG"
        assert row["status"] == "In Progress"

    def test_projects_table(self, conn):
        conn.execute(
            "INSERT INTO projects (id, client_id, name, status, created_at, updated_at) "
            "VALUES ('p1', 'c1', 'Q1 Content', 'Not Started', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM projects WHERE id='p1'").fetchone()
        assert row["name"] == "Q1 Content"

    def test_tasks_table(self, conn):
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, status, created_at, updated_at) "
            "VALUES ('t1', 'p1', 'Design banner', 'To Do', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM tasks WHERE id='t1'").fetchone()
        assert row["status"] == "To Do"

    def test_efforts_table(self, conn):
        conn.execute(
            "INSERT INTO efforts (id, task_id, team_member_id, hours, date, created_at, updated_at) "
            "VALUES ('e1', 't1', 'tm1', 2.5, '2025-01-15', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM efforts WHERE id='e1'").fetchone()
        assert row["hours"] == 2.5

    def test_expenses_table(self, conn):
        conn.execute(
            "INSERT INTO expenses (id, name, amount_cents, category, date, created_at, updated_at) "
            "VALUES ('exp1', 'Meta Ads Jan', 50000, 'Ad Spend', '2025-01-01', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM expenses WHERE id='exp1'").fetchone()
        assert row["amount_cents"] == 50000
        assert row["category"] == "Ad Spend"

    def test_meetings_table(self, conn):
        conn.execute(
            "INSERT INTO meetings (id, client_id, name, date, meeting_type, created_at, updated_at) "
            "VALUES ('m1', 'c1', 'Kickoff', '2025-01-10', 'Onboarding', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM meetings WHERE id='m1'").fetchone()
        assert row["meeting_type"] == "Onboarding"

    def test_contacts_table(self, conn):
        conn.execute(
            "INSERT INTO contacts (id, name, email, contact_type, created_at, updated_at) "
            "VALUES ('ct1', 'John Doe', 'john@example.com', 'Lead', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM contacts WHERE id='ct1'").fetchone()
        assert row["email"] == "john@example.com"

    def test_sop_library_table(self, conn):
        conn.execute(
            "INSERT INTO sop_library (id, name, department, status, created_at, updated_at) "
            "VALUES ('sop1', 'Client Onboarding', 'Operations', 'Active', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM sop_library WHERE id='sop1'").fetchone()
        assert row["department"] == "Operations"

    def test_views_registry_table(self, conn):
        conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) "
            "VALUES ('vr1', 'clients', 'Active Clients', 1, 'ok', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM views_registry WHERE id='vr1'").fetchone()
        assert row["view_name"] == "Active Clients"

    def test_system_settings_table(self, conn):
        conn.execute(
            "INSERT INTO system_settings (key, value, description, updated_at) "
            "VALUES ('os_version', '1.0.0', 'OS version', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM system_settings WHERE key='os_version'").fetchone()
        assert row["value"] == "1.0.0"

    def test_views_registry_unique_constraint(self, conn):
        conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) "
            "VALUES ('vr1', 'clients', 'Active Clients', 1, 'ok', '2025-01-01', '2025-01-01')"
        )
        # Upsert should work
        conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) "
            "VALUES ('vr2', 'clients', 'Active Clients', 1, 'missing', '2025-01-02', '2025-01-02') "
            "ON CONFLICT(database_key, view_name) DO UPDATE SET status=excluded.status"
        )
        row = conn.execute("SELECT * FROM views_registry WHERE database_key='clients' AND view_name='Active Clients'").fetchone()
        assert row["status"] == "missing"


# ── Types tests ──


class TestTypes:
    def test_drift_issue_v2_healable(self):
        from packages.agencyu.notion.types import DriftIssueV2, DriftSeverity

        issue = DriftIssueV2(
            database="clients",
            issue_type="missing_property",
            property_name="mrr",
            severity=DriftSeverity.HIGH,
            details="Property 'mrr' missing",
        )
        assert issue.healable is True
        assert issue.is_critical is False

    def test_drift_issue_v2_not_healable(self):
        from packages.agencyu.notion.types import DriftIssueV2, DriftSeverity

        issue = DriftIssueV2(
            database="clients",
            issue_type="wrong_type",
            property_name="mrr",
            severity=DriftSeverity.CRITICAL,
            details="Wrong type",
        )
        assert issue.healable is False
        assert issue.is_critical is True

    def test_compliance_report_counts(self):
        from packages.agencyu.notion.types import ComplianceReport, DriftIssueV2, DriftSeverity

        report = ComplianceReport(
            ok=False,
            issues=[
                DriftIssueV2("a", "missing_property", "x", DriftSeverity.HIGH, ""),
                DriftIssueV2("a", "wrong_type", "y", DriftSeverity.CRITICAL, ""),
                DriftIssueV2("b", "missing_select_options", "z", DriftSeverity.MEDIUM, ""),
            ],
        )
        assert report.healable_count == 2
        assert report.manual_count == 1
        assert report.critical_count == 1


# ── Rate Limiter tests ──


class TestRateLimiter:
    def test_first_call_no_wait(self):
        from packages.agencyu.notion.rate_limit import RateLimiter

        rl = RateLimiter(default_interval_s=0.01)
        rl.wait("test")
        assert rl.stats["tracked_resources"] == 1

    def test_reset(self):
        from packages.agencyu.notion.rate_limit import RateLimiter

        rl = RateLimiter()
        rl.wait("a")
        rl.wait("b")
        assert rl.stats["tracked_resources"] == 2
        rl.reset("a")
        assert rl.stats["tracked_resources"] == 1
        rl.reset()
        assert rl.stats["tracked_resources"] == 0


# ── Compliance Verifier tests ──


class TestComplianceVerifier:
    def test_offline_verify_all_present(self, conn):
        from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier

        # Build a mock NotionAPI
        mock_api = MagicMock()
        mock_api.can_read_page.return_value = True

        verifier = NotionComplianceVerifier(
            notion_api=mock_api,
            conn=conn,
            root_page_id="root123",
        )

        # Build minimal schemas matching manifest
        schemas = {}
        for db_key, db_spec in verifier.manifest.get("databases", {}).items():
            props = {}
            for prop_name, prop_spec in db_spec.get("properties", {}).items():
                prop_type = prop_spec.get("type", "rich_text")
                prop_data = {"type": prop_type}
                if "options" in prop_spec:
                    prop_data["options"] = prop_spec["options"]
                props[prop_name] = prop_data
            schemas[db_key] = {"properties": props}

        report = verifier.verify_offline(schemas)
        assert report.ok is True
        assert len(report.issues) == 0
        assert report.databases_missing == 0

    def test_offline_verify_missing_database(self, conn):
        from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier

        mock_api = MagicMock()
        verifier = NotionComplianceVerifier(
            notion_api=mock_api,
            conn=conn,
            root_page_id="root123",
        )

        # Provide empty schemas — all DBs missing
        report = verifier.verify_offline({})
        assert report.ok is False
        assert report.databases_missing > 0

        # Check that required DBs are flagged as critical
        critical_dbs = [i for i in report.issues if i.issue_type == "missing_database" and i.is_critical]
        assert len(critical_dbs) > 0  # clients, work_orders, etc.

    def test_offline_verify_missing_property(self, conn):
        from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier

        mock_api = MagicMock()
        verifier = NotionComplianceVerifier(
            notion_api=mock_api,
            conn=conn,
            root_page_id="root123",
        )

        # Provide clients DB with missing properties
        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    # Missing ghl_contact_id, trello_board_id, etc.
                }
            }
        }

        report = verifier.verify_offline(schemas)
        missing_props = [i for i in report.issues if i.issue_type == "missing_property" and i.database == "clients"]
        assert len(missing_props) > 0

    def test_offline_verify_wrong_type(self, conn):
        from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier

        mock_api = MagicMock()
        verifier = NotionComplianceVerifier(
            notion_api=mock_api,
            conn=conn,
            root_page_id="root123",
        )

        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    "ghl_contact_id": {"type": "number"},  # Should be rich_text
                    "trello_board_id": {"type": "rich_text"},
                    "service_package": {"type": "select", "options": ["Retainer", "Rollout", "CutMV", "Custom"]},
                    "status": {"type": "select", "options": ["Lead", "Active", "Paused", "Completed"]},
                }
            }
        }

        report = verifier.verify_offline(schemas)
        wrong_type = [i for i in report.issues if i.issue_type == "wrong_type" and i.database == "clients"]
        assert len(wrong_type) == 1
        assert wrong_type[0].property_name == "ghl_contact_id"
        assert wrong_type[0].is_critical is True

    def test_offline_verify_missing_select_options(self, conn):
        from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier

        mock_api = MagicMock()
        mock_api.extract_select_options.side_effect = lambda prop: prop.get("options", [])

        verifier = NotionComplianceVerifier(
            notion_api=mock_api,
            conn=conn,
            root_page_id="root123",
        )

        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    "ghl_contact_id": {"type": "rich_text"},
                    "trello_board_id": {"type": "rich_text"},
                    "service_package": {"type": "select", "options": ["Retainer"]},  # Missing others
                    "status": {"type": "select", "options": ["Lead", "Active", "Paused", "Completed"]},
                }
            }
        }

        report = verifier.verify_offline(schemas)
        missing_opts = [i for i in report.issues if i.issue_type == "missing_select_options"]
        assert len(missing_opts) >= 1

    def test_persist_report(self, conn):
        from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier
        from packages.agencyu.notion.types import ComplianceReport

        mock_api = MagicMock()
        verifier = NotionComplianceVerifier(
            notion_api=mock_api,
            conn=conn,
            root_page_id="root123",
        )

        report = ComplianceReport(ok=True, manifest_version="2.0", databases_checked=5)
        verifier.persist_report(report)

        row = conn.execute("SELECT * FROM system_snapshots WHERE key='last_compliance_check'").fetchone()
        assert row is not None
        assert "2.0" in row["value_json"]


# ── Views Registry tests ──


class TestViewsRegistry:
    def test_seed_views_registry(self, conn):
        from packages.agencyu.sync.views_registry import seed_views_registry

        count = seed_views_registry(conn)
        assert count > 0

        # Check some expected entries
        row = conn.execute(
            "SELECT * FROM views_registry WHERE database_key='clients' AND view_name='Active Clients'"
        ).fetchone()
        assert row is not None
        assert row["required"] == 1
        assert row["status"] == "unknown"

    def test_seed_idempotent(self, conn):
        from packages.agencyu.sync.views_registry import seed_views_registry

        count1 = seed_views_registry(conn)
        count2 = seed_views_registry(conn)
        assert count1 == count2

        # Should not duplicate
        total = conn.execute("SELECT COUNT(*) FROM views_registry").fetchone()[0]
        assert total == count1

    def test_get_views_status(self, conn):
        from packages.agencyu.sync.views_registry import get_views_status, seed_views_registry

        seed_views_registry(conn)
        status = get_views_status(conn)
        assert status["total_views"] > 0
        assert status["unknown"] > 0
        assert len(status["by_database"]) > 0

    def test_mark_view_status(self, conn):
        from packages.agencyu.sync.views_registry import mark_view_status, seed_views_registry

        seed_views_registry(conn)
        mark_view_status(conn, database_key="clients", view_name="Active Clients", status="ok")

        row = conn.execute(
            "SELECT * FROM views_registry WHERE database_key='clients' AND view_name='Active Clients'"
        ).fetchone()
        assert row["status"] == "ok"
        assert row["last_verified_at"] is not None


# ── Manifest v2.0 tests ──


class TestManifestV2:
    def test_manifest_version_is_2(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        assert manifest["version"] == "2.1"

    def test_manifest_has_all_agencyos_dbs(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        dbs = set(manifest["databases"].keys())

        expected = {
            "clients", "outcomes", "projects", "tasks", "efforts",
            "work_orders", "crm_pipeline", "invoices", "expenses",
            "meetings", "contacts", "sop_library", "agency_assets",
            "client_assets", "team_directory", "views_registry",
        }
        assert expected.issubset(dbs), f"Missing: {expected - dbs}"

    def test_manifest_clients_has_cross_system_ids(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        client_props = set(manifest["databases"]["clients"]["properties"].keys())

        required_ids = {"ghl_contact_id", "trello_board_id", "stripe_customer_id", "qb_customer_id"}
        assert required_ids.issubset(client_props), f"Missing: {required_ids - client_props}"

    def test_manifest_crm_has_attribution_fields(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        crm_props = set(manifest["databases"]["crm_pipeline"]["properties"].keys())

        required = {"utm_source", "utm_campaign", "utm_adset", "utm_ad", "manychat_tags", "assigned_setter", "deal_value"}
        assert required.issubset(crm_props), f"Missing: {required - crm_props}"

    def test_manifest_invoices_has_reconciliation_fields(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        inv_props = set(manifest["databases"]["invoices"]["properties"].keys())

        required = {"stripe_payment_intent_id", "stripe_invoice_id", "qb_invoice_id", "period"}
        assert required.issubset(inv_props), f"Missing: {required - inv_props}"

    def test_manifest_all_dbs_have_required_views(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())

        for db_key, db_spec in manifest["databases"].items():
            views = db_spec.get("required_views", [])
            assert len(views) >= 1, f"Database '{db_key}' has no required views"

    def test_manifest_relations_reference_valid_dbs(self):
        import yaml
        manifest_path = Path(__file__).parent.parent / "packages" / "agencyu" / "notion" / "template_manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        db_keys = set(manifest["databases"].keys())

        for db_key, db_spec in manifest["databases"].items():
            for prop_name, prop_spec in db_spec.get("properties", {}).items():
                if prop_spec.get("type") == "relation":
                    target = prop_spec.get("target")
                    assert target in db_keys, f"{db_key}.{prop_name} references unknown DB '{target}'"
