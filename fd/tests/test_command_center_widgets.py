"""Tests for the Command Center widget layer: registry, renderers, compliance, writer."""
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


NOW = "2026-03-05T00:00:00Z"


def _set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Insert a system_settings row with required columns."""
    conn.execute(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
        (key, value, NOW),
    )
    conn.commit()


def _bind(conn: sqlite3.Connection, binding_type: str, notion_id: str) -> None:
    """Insert a notion_bindings row with required columns."""
    conn.execute(
        "INSERT OR IGNORE INTO notion_bindings "
        "(id, binding_type, notion_object_id, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (f"b_{binding_type}", binding_type, notion_id, NOW, NOW),
    )
    conn.commit()


def _bind_all(conn: sqlite3.Connection) -> None:
    """Bind all required databases and root pages from manifest."""
    manifest = _load_manifest()
    for db_key in manifest.get("databases", {}):
        _bind(conn, db_key, f"fake_id_{db_key}")
    for page in manifest.get("required_root_pages", []):
        pk = page.get("page_key", "")
        if pk:
            _bind(conn, pk, f"fake_page_{pk}")


def _seed_view_keys(conn: sqlite3.Connection) -> None:
    """Seed all required CC view_keys into views_registry."""
    manifest = _load_manifest()
    cc = manifest.get("command_center", {})
    for entry in cc.get("required_views_registry_entries", []):
        vk = entry.get("view_key", "")
        dk = entry.get("db_key", "")
        if vk:
            conn.execute(
                "INSERT OR IGNORE INTO views_registry "
                "(id, database_key, view_name, required, status, created_at, updated_at) "
                "VALUES (?, ?, ?, 1, 'ok', ?, ?)",
                (f"vr_{vk}", dk, vk, NOW, NOW),
            )
    conn.commit()


# ════════════════════════════════════════════
# Widget Registry Tests
# ════════════════════════════════════════════


class TestWidgetRegistry:
    def test_all_widgets_have_unique_keys(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS

        keys = [w.widget_key for w in ALL_WIDGETS]
        assert len(keys) == len(set(keys))

    def test_all_widgets_have_renderers(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS

        for w in ALL_WIDGETS:
            assert w.renderer, f"Widget {w.widget_key} has no renderer"

    def test_all_widgets_have_marker_keys(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS

        for w in ALL_WIDGETS:
            mk = w.effective_marker_key
            assert mk, f"Widget {w.widget_key} has no marker key"
            assert "." not in mk, f"Marker key {mk} should not contain dots"

    def test_marker_start_end_format(self):
        from packages.agencyu.notion.widgets.widget_registry import EXECUTIVE_STRIP

        assert "[[OPENCLAW:" in EXECUTIVE_STRIP.marker_start
        assert ":START]]" in EXECUTIVE_STRIP.marker_start
        assert ":END]]" in EXECUTIVE_STRIP.marker_end

    def test_get_widget_spec(self):
        from packages.agencyu.notion.widgets.widget_registry import get_widget_spec

        spec = get_widget_spec("cc.executive_strip")
        assert spec is not None
        assert spec.title == "Today at a Glance"

    def test_get_all_required_view_keys(self):
        from packages.agencyu.notion.widgets.widget_registry import get_all_required_view_keys

        keys = get_all_required_view_keys()
        assert "cc.active_combos" in keys
        assert "cc.pipeline_quality" in keys
        assert "audit.recent" in keys

    def test_validate_widget_views_all_present(self):
        from packages.agencyu.notion.widgets.widget_registry import (
            EXECUTIVE_STRIP,
            validate_widget_views,
        )

        available = {"cc.active_combos", "cc.pipeline_quality", "cc.finance_snapshot"}
        missing = validate_widget_views(EXECUTIVE_STRIP, available)
        assert missing == []

    def test_validate_widget_views_missing(self):
        from packages.agencyu.notion.widgets.widget_registry import (
            EXECUTIVE_STRIP,
            validate_widget_views,
        )

        available = {"cc.active_combos"}
        missing = validate_widget_views(EXECUTIVE_STRIP, available)
        assert "cc.pipeline_quality" in missing
        assert "cc.finance_snapshot" in missing

    def test_widget_count(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS

        assert len(ALL_WIDGETS) == 16

    def test_widget_by_key_dict(self):
        from packages.agencyu.notion.widgets.widget_registry import WIDGET_BY_KEY

        assert "cc.executive_strip" in WIDGET_BY_KEY
        assert "cc.systems_reliability" in WIDGET_BY_KEY


# ════════════════════════════════════════════
# Widget Renderers Tests
# ════════════════════════════════════════════


class TestWidgetRenderers:
    def test_render_executive_strip(self):
        from packages.agencyu.notion.widgets.widget_registry import EXECUTIVE_STRIP
        from packages.agencyu.notion.widgets.widget_renderers import render_executive_strip

        data = {
            "active_clients": 12,
            "pipeline_calls_7d": 25,
            "pipeline_showed_7d": 18,
            "close_rate_7d": 0.35,
            "revenue_7d": 15000.0,
            "open_invoices": 3,
            "overdue_tasks": 1,
            "system_status": "healthy",
        }
        blocks = render_executive_strip(data, EXECUTIVE_STRIP)
        assert len(blocks) >= 3
        # First block is H2
        assert blocks[0]["type"] == "heading_2"
        # Has callout with KPI data
        callout_block = next(b for b in blocks if b["type"] == "callout")
        text = callout_block["callout"]["rich_text"][0]["text"]["content"]
        assert "Active Clients: 12" in text
        assert "Money In (7d): $15,000" in text

    def test_render_pipeline_quality_green(self):
        from packages.agencyu.notion.widgets.widget_registry import PIPELINE_QUALITY
        from packages.agencyu.notion.widgets.widget_renderers import render_pipeline_quality

        data = {
            "calls_booked_7d": 20,
            "calls_showed_7d": 16,
            "no_shows_7d": 4,
            "close_rate_7d": 0.25,
            "show_rate_7d": 0.8,
            "avg_deal_value": 3500.0,
        }
        blocks = render_pipeline_quality(data, PIPELINE_QUALITY)
        # Good show rate → green
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "green_background"

    def test_render_pipeline_quality_red(self):
        from packages.agencyu.notion.widgets.widget_registry import PIPELINE_QUALITY
        from packages.agencyu.notion.widgets.widget_renderers import render_pipeline_quality

        data = {"show_rate_7d": 0.3}
        blocks = render_pipeline_quality(data, PIPELINE_QUALITY)
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "red_background"

    def test_render_finance_snapshot_overdue(self):
        from packages.agencyu.notion.widgets.widget_registry import FINANCE_SNAPSHOT
        from packages.agencyu.notion.widgets.widget_renderers import render_finance_snapshot

        data = {"overdue_invoices_count": 2, "revenue_7d": 5000}
        blocks = render_finance_snapshot(data, FINANCE_SNAPSHOT)
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "red_background"

    def test_render_finance_snapshot_clean(self):
        from packages.agencyu.notion.widgets.widget_registry import FINANCE_SNAPSHOT
        from packages.agencyu.notion.widgets.widget_renderers import render_finance_snapshot

        data = {"overdue_invoices_count": 0}
        blocks = render_finance_snapshot(data, FINANCE_SNAPSHOT)
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "green_background"

    def test_render_fulfillment_watchlist_empty(self):
        from packages.agencyu.notion.widgets.widget_registry import FULFILLMENT_WATCHLIST
        from packages.agencyu.notion.widgets.widget_renderers import render_fulfillment_watchlist

        data = {"overdue_tasks": [], "stuck_tasks": [], "tasks_due_today": 0}
        blocks = render_fulfillment_watchlist(data, FULFILLMENT_WATCHLIST)
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "green_background"

    def test_render_fulfillment_watchlist_overdue(self):
        from packages.agencyu.notion.widgets.widget_registry import FULFILLMENT_WATCHLIST
        from packages.agencyu.notion.widgets.widget_renderers import render_fulfillment_watchlist

        data = {
            "overdue_tasks": [
                {"title": "Logo v2", "client": "Acme", "due": "2026-03-01"},
                {"title": "Banner", "client": "Acme", "due": "2026-03-02"},
                {"title": "Copy", "client": "Beta", "due": "2026-03-02"},
                {"title": "Video", "client": "Beta", "due": "2026-03-02"},
            ],
            "stuck_tasks": [],
            "tasks_due_today": 2,
        }
        blocks = render_fulfillment_watchlist(data, FULFILLMENT_WATCHLIST)
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "red_background"

    def test_render_systems_reliability_healthy(self):
        from packages.agencyu.notion.widgets.widget_registry import SYSTEMS_RELIABILITY
        from packages.agencyu.notion.widgets.widget_renderers import render_systems_reliability

        data = {
            "drift_issues": 0,
            "audit_errors_24h": 0,
            "cooldown_active": False,
            "write_lock": False,
            "safe_mode": False,
            "queue_depth": 5,
            "integrations_mode": "clawdcursor_preferred",
        }
        blocks = render_systems_reliability(data, SYSTEMS_RELIABILITY)
        callout_block = next(b for b in blocks if b["type"] == "callout")
        assert callout_block["callout"]["color"] == "green_background"

    def test_render_systems_reliability_write_lock(self):
        from packages.agencyu.notion.widgets.widget_registry import SYSTEMS_RELIABILITY
        from packages.agencyu.notion.widgets.widget_renderers import render_systems_reliability

        data = {"write_lock": True, "drift_issues": 0, "audit_errors_24h": 0, "cooldown_active": False}
        blocks = render_systems_reliability(data, SYSTEMS_RELIABILITY)
        # Should have the lock callout
        lock_blocks = [b for b in blocks if b["type"] == "callout" and
                       b["callout"]["color"] == "red_background"]
        assert len(lock_blocks) >= 1

    def test_render_widget_missing_views_shows_repair(self):
        from packages.agencyu.notion.widgets.widget_registry import EXECUTIVE_STRIP
        from packages.agencyu.notion.widgets.widget_renderers import render_widget

        available = set()  # no views
        blocks = render_widget(EXECUTIVE_STRIP, {}, available)
        # Should show repair block
        assert any(b["type"] == "heading_2" for b in blocks)
        h2_text = blocks[0]["heading_2"]["rich_text"][0]["text"]["content"]
        assert "Needs Setup" in h2_text

    def test_render_widget_dispatches_correctly(self):
        from packages.agencyu.notion.widgets.widget_registry import EXECUTIVE_STRIP
        from packages.agencyu.notion.widgets.widget_renderers import render_widget

        # All views available → should render executive strip
        available = {"cc.active_combos", "cc.pipeline_quality", "cc.finance_snapshot"}
        blocks = render_widget(EXECUTIVE_STRIP, {"active_clients": 5}, available)
        assert blocks[0]["type"] == "heading_2"
        text = blocks[0]["heading_2"]["rich_text"][0]["text"]["content"]
        assert "Today at a Glance" in text

    def test_render_active_combos_empty(self):
        from packages.agencyu.notion.widgets.widget_registry import ACTIVE_COMBOS_TABLE
        from packages.agencyu.notion.widgets.widget_renderers import render_active_combos

        blocks = render_active_combos({}, ACTIVE_COMBOS_TABLE)
        assert len(blocks) >= 2
        # Has a "No active outcomes" callout
        callout_blocks = [b for b in blocks if b["type"] == "callout"]
        assert len(callout_blocks) >= 1

    def test_render_active_combos_with_data(self):
        from packages.agencyu.notion.widgets.widget_registry import ACTIVE_COMBOS_TABLE
        from packages.agencyu.notion.widgets.widget_renderers import render_active_combos

        data = {
            "combos": [
                {"client": "Acme", "outcome": "100 leads", "status": "on_track", "target": 100, "current": 75},
                {"client": "Beta", "outcome": "Launch site", "status": "at_risk"},
            ]
        }
        blocks = render_active_combos(data, ACTIVE_COMBOS_TABLE)
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 2


# ════════════════════════════════════════════
# Compliance Verifier Tests
# ════════════════════════════════════════════


class TestComplianceVerifier:
    def test_fully_compliant(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.compliance_verifier import CommandCenterComplianceVerifier

        # Bind all required databases + pages + views
        _bind_all(conn)
        _seed_view_keys(conn)
        _set_setting(conn, "write_lock", "false")

        verifier = CommandCenterComplianceVerifier(conn)
        report = verifier.verify(
            registered_widgets={"cc.executive_strip", "cc.active_combos_table",
                                "cc.pipeline_quality_panel", "cc.fulfillment_watchlist",
                                "cc.finance_snapshot", "cc.systems_reliability",
                                "cc.fix_list", "cc.skills_recommendations",
                                "cc.db_registry", "cc.kpis", "cc.pipeline",
                                "cc.cash", "cc.calendar", "cc.alerts",
                                "cc.projects", "cc.quick_actions"},
            registered_portal_sections={"start_here", "trello", "dropbox", "delivery",
                                         "finance", "system_notes"},
        )
        assert report.compliant is True
        assert report.missing_db_keys == []
        assert report.missing_widgets == []
        assert report.missing_portal_sections == []

    def test_missing_databases(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.compliance_verifier import CommandCenterComplianceVerifier

        _set_setting(conn, "write_lock", "false")

        verifier = CommandCenterComplianceVerifier(conn)
        report = verifier.verify(registered_widgets=set(), registered_portal_sections=set())
        assert report.compliant is False
        assert len(report.missing_db_keys) > 0
        assert "system_settings" in report.missing_db_keys

    def test_missing_widgets(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.compliance_verifier import CommandCenterComplianceVerifier

        _bind_all(conn)
        _set_setting(conn, "write_lock", "false")

        verifier = CommandCenterComplianceVerifier(conn)
        report = verifier.verify(
            registered_widgets={"cc.executive_strip"},  # Missing others
            registered_portal_sections={"start_here", "trello", "dropbox", "delivery",
                                         "finance", "system_notes"},
        )
        assert report.compliant is False
        assert "cc.pipeline_quality_panel" in report.missing_widgets

    def test_missing_portal_sections(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.compliance_verifier import CommandCenterComplianceVerifier

        _bind_all(conn)
        _set_setting(conn, "write_lock", "false")

        verifier = CommandCenterComplianceVerifier(conn)
        report = verifier.verify(
            registered_widgets=set(),
            registered_portal_sections={"start_here"},  # Missing others
        )
        assert "trello" in report.missing_portal_sections

    def test_write_lock_warning(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.compliance_verifier import CommandCenterComplianceVerifier

        _set_setting(conn, "write_lock", "true")

        verifier = CommandCenterComplianceVerifier(conn)
        report = verifier.verify()
        assert report.write_lock is True
        assert any("write_lock" in w for w in report.warnings)

    def test_report_summary_compliant(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.compliance_verifier import ComplianceReport

        report = ComplianceReport(compliant=True)
        assert report.summary == "Command Center is compliant"

    def test_report_summary_not_compliant(self):
        from packages.agencyu.notion.widgets.compliance_verifier import ComplianceReport

        report = ComplianceReport(
            compliant=False,
            missing_db_keys=["tasks"],
            missing_view_keys=["cc.pipeline_quality"],
        )
        assert "NOT compliant" in report.summary
        assert "tasks" in report.summary

    def test_report_to_dict(self):
        from packages.agencyu.notion.widgets.compliance_verifier import (
            ComplianceReport,
            MissingProperty,
        )

        report = ComplianceReport(
            compliant=False,
            missing_db_properties=[MissingProperty("tasks", "status", "select")],
        )
        d = report.to_dict()
        assert d["compliant"] is False
        assert len(d["missing_db_properties"]) == 1
        assert d["missing_db_properties"][0]["property_key"] == "status"


# ════════════════════════════════════════════
# NotionWidgetWriter Tests
# ════════════════════════════════════════════


class TestNotionWidgetWriter:
    def test_write_all_safe_mode(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        mock_api.list_all_block_children.return_value = []

        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        result = writer.write_all(safe_mode=True)
        assert result["writes"] == 0
        assert result["skipped"] == 16  # All widgets skipped
        mock_api.append_block_children.assert_not_called()

    def test_write_all_live_mode(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        mock_api.list_all_block_children.return_value = []

        _set_setting(conn, "write_lock", "false")

        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        result = writer.write_all(safe_mode=False)
        assert result["writes"] == 16
        assert result["errors"] == 0
        assert mock_api.append_block_children.call_count == 16

    def test_write_all_with_data_provider(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        mock_api.list_all_block_children.return_value = []

        _set_setting(conn, "write_lock", "false")

        def my_data(spec):
            return {"active_clients": 10, "revenue_7d": 5000}

        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        result = writer.write_all(safe_mode=False, data_provider=my_data)
        assert result["writes"] == 16

    def test_write_all_no_page_id(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        writer = NotionWidgetWriter(conn, mock_api, "")
        result = writer.write_all()
        assert result["writes"] == 0
        assert "warnings" in result

    def test_write_lock_forces_safe_mode(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        mock_api.list_all_block_children.return_value = []

        # write_lock ON
        _set_setting(conn, "write_lock", "true")

        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        result = writer.write_all(safe_mode=False)  # Requested live, but lock is on
        assert result["writes"] == 0
        assert result["skipped"] == 16

    def test_plan_write_all(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        plan = writer.plan_write_all()
        assert plan["total_widgets"] == 16
        assert len(plan["plan"]) == 16
        for item in plan["plan"]:
            assert "widget_key" in item
            assert "marker_key" in item

    def test_max_writes_cap(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        mock_api.list_all_block_children.return_value = []

        _set_setting(conn, "write_lock", "false")

        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        result = writer.write_all(safe_mode=False, max_writes=2)
        assert result["writes"] == 2

    def test_fetch_blocks_error_graceful(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.widgets.widgets import NotionWidgetWriter

        mock_api = MagicMock()
        mock_api.list_all_block_children.side_effect = RuntimeError("API down")

        writer = NotionWidgetWriter(conn, mock_api, "page_123")
        result = writer.write_all(safe_mode=False)
        assert result["errors"] == 1
        assert result["writes"] == 0


# ════════════════════════════════════════════
# Orchestrator Widget Integration Tests
# ════════════════════════════════════════════


class TestOrchestratorWidgetIntegration:
    def test_set_widget_writer(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.mirror.mirror_orchestrator import MirrorOrchestrator

        mock_api = MagicMock()
        orch = MirrorOrchestrator(conn, mock_api)
        mock_widget_writer = MagicMock()
        orch.set_widget_writer(mock_widget_writer)
        assert orch._widget_writer is mock_widget_writer

    def test_orchestrator_runs_widgets(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.mirror.mirror_orchestrator import (
            MirrorOrchestrator,
            OrchestratorConfig,
        )

        mock_api = MagicMock()
        _set_setting(conn, "write_lock", "false")

        config = OrchestratorConfig(safe_mode=False)
        orch = MirrorOrchestrator(conn, mock_api, config=config)

        mock_widget_writer = MagicMock()
        mock_widget_writer.write_all.return_value = {"writes": 3, "skipped": 0, "errors": 0}
        orch.set_widget_writer(mock_widget_writer)

        result = orch.run(correlation_id="test_123")
        assert result["ok"] is True
        mock_widget_writer.write_all.assert_called_once()
        assert "command_center_widgets" in result["writers_run"]

    def test_orchestrator_safe_mode_widgets(self, conn):
        # tables created by init_schema
        from packages.agencyu.notion.mirror.mirror_orchestrator import MirrorOrchestrator

        mock_api = MagicMock()
        orch = MirrorOrchestrator(conn, mock_api)  # safe_mode=True by default

        mock_widget_writer = MagicMock()
        mock_widget_writer.write_all.return_value = {"writes": 0, "skipped": 6, "errors": 0}
        orch.set_widget_writer(mock_widget_writer)

        result = orch.run(correlation_id="test_safe")
        assert result["ok"] is True
        # Widget writer should still be called (with safe_mode=True)
        call_kwargs = mock_widget_writer.write_all.call_args
        assert call_kwargs[1]["safe_mode"] is True


# ════════════════════════════════════════════
# Manifest Tests
# ════════════════════════════════════════════


class TestManifest:
    def test_manifest_loads(self):
        manifest = _load_manifest()
        assert manifest["version"] == "2.1"
        assert manifest["os_version"] == "agencyos+fulldigital.1"

    def test_manifest_has_command_center(self):
        manifest = _load_manifest()
        cc = manifest.get("command_center", {})
        assert "required_widgets" in cc
        assert "required_views_registry_entries" in cc
        assert len(cc["required_widgets"]) == 16

    def test_manifest_has_portal_templates(self):
        manifest = _load_manifest()
        pt = manifest.get("portal_templates", {})
        assert len(pt.get("required_sections", [])) == 6

    def test_manifest_has_ux_rules(self):
        manifest = _load_manifest()
        ux = manifest.get("ux_rules", {})
        assert ux["layout"]["max_heading_levels"] == 2
        assert ux["text"]["no_jargon"] is True

    def test_manifest_governance_clawdcursor(self):
        manifest = _load_manifest()
        gov = manifest.get("governance", {})
        assert gov["integrations_mode"] == "clawdcursor_preferred"

    def test_manifest_required_root_pages(self):
        manifest = _load_manifest()
        pages = manifest.get("required_root_pages", [])
        page_keys = [p["page_key"] for p in pages]
        assert "command_center" in page_keys
        assert "ops_console" in page_keys
        assert "client_portal_root" in page_keys

    def test_manifest_all_databases_present(self):
        manifest = _load_manifest()
        dbs = manifest.get("databases", {})
        expected = [
            "system_settings", "views_registry", "system_audit_log",
            "clients", "outcomes", "projects", "tasks", "efforts",
            "work_orders", "crm_pipeline", "attribution_touchpoints",
            "invoices", "expenses", "meetings", "contacts",
            "sop_library", "agency_assets", "client_assets", "team_directory",
        ]
        for key in expected:
            assert key in dbs, f"Missing database: {key}"

    def test_manifest_system_settings_page(self):
        manifest = _load_manifest()
        ssp = manifest.get("system_settings_page", {})
        prop_keys = [p["key"] for p in ssp.get("required_properties", [])]
        assert "integrations_mode" in prop_keys
        assert "notion_widget_style" in prop_keys

    def test_manifest_cc_view_entries(self):
        manifest = _load_manifest()
        cc = manifest.get("command_center", {})
        entries = cc.get("required_views_registry_entries", [])
        view_keys = [e["view_key"] for e in entries]
        assert "cc.active_combos" in view_keys
        assert "cc.pipeline_quality" in view_keys
        assert "cc.finance_snapshot" in view_keys
        assert "cc.fulfillment_watchlist" in view_keys
        assert "audit.recent" in view_keys


# ════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════


def _load_manifest():
    from packages.agencyu.notion.manifest_validator import load_yaml_manifest

    return load_yaml_manifest()
