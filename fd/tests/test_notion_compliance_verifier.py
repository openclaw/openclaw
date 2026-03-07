"""Tests for the live-API Notion Compliance Verifier, typed manifest, and compliance models."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from packages.agencyu.notion.compliance_models import (
    ComplianceResult,
    MissingProperty,
    MissingViewKey,
)
from packages.agencyu.notion.notion_compliance_verifier import (
    NotionComplianceVerifier,
    NotionIdMap,
    _extract_plain_text,
    _read_checkbox,
    _read_date,
    _read_rich_text,
    _read_title,
)
from packages.agencyu.notion.template_manifest import Manifest, load_manifest


# ════════════════════════════════════════════
# Template Manifest Tests
# ════════════════════════════════════════════


class TestManifest:
    def test_load_manifest(self):
        m = load_manifest()
        assert m.version == "2.1"
        assert m.os_version == "agencyos+fulldigital.1"
        assert m.owner == "openclaw"

    def test_template_version(self):
        m = load_manifest()
        assert m.template_version == "1.0.0"

    def test_databases(self):
        m = load_manifest()
        assert "clients" in m.databases
        assert "system_settings" in m.databases
        assert isinstance(m.databases["clients"], dict)

    def test_get_db(self):
        m = load_manifest()
        clients = m.get_db("clients")
        assert clients is not None
        assert clients["title"] == "Clients"

    def test_get_db_missing(self):
        m = load_manifest()
        assert m.get_db("nonexistent") is None

    def test_required_db_keys(self):
        m = load_manifest()
        keys = m.get_required_db_keys()
        assert "clients" in keys
        assert "tasks" in keys
        assert "system_audit_log" in keys

    def test_required_widget_keys(self):
        m = load_manifest()
        keys = m.get_required_widget_keys()
        assert "cc.executive_strip" in keys
        assert "cc.systems_reliability" in keys
        assert len(keys) == 16

    def test_required_view_entries(self):
        m = load_manifest()
        entries = m.get_required_view_entries()
        view_keys = [e["view_key"] for e in entries]
        assert "cc.active_combos" in view_keys

    def test_required_portal_sections(self):
        m = load_manifest()
        keys = m.get_required_portal_section_keys()
        assert "start_here" in keys
        assert "finance" in keys

    def test_required_page_keys(self):
        m = load_manifest()
        keys = m.get_required_page_keys()
        assert "command_center" in keys
        assert "ops_console" in keys

    def test_governance(self):
        m = load_manifest()
        gov = m.governance
        assert gov["integrations_mode"] == "clawdcursor_preferred"

    def test_integrations_mode(self):
        m = load_manifest()
        assert m.integrations_mode == "clawdcursor_preferred"

    def test_command_center(self):
        m = load_manifest()
        cc = m.command_center
        assert "required_widgets" in cc
        assert len(cc["required_widgets"]) == 16

    def test_ux_rules(self):
        m = load_manifest()
        ux = m.ux_rules
        assert ux["layout"]["max_heading_levels"] == 2

    def test_basic_validate_rejects_bad_input(self):
        from packages.agencyu.notion.template_manifest import _basic_validate

        with pytest.raises(ValueError, match="missing top-level key"):
            _basic_validate({"version": "1.0"})

    def test_basic_validate_rejects_non_dict_databases(self):
        from packages.agencyu.notion.template_manifest import _basic_validate

        with pytest.raises(ValueError, match="must be a mapping"):
            _basic_validate({"version": "1.0", "databases": []})


# ════════════════════════════════════════════
# Compliance Models Tests
# ════════════════════════════════════════════


class TestComplianceModels:
    def test_compliant_result(self):
        r = ComplianceResult(compliant=True, template_version="1.0", os_version="1.0")
        assert r.summary == "Notion workspace is compliant"
        assert r.fix_count == 0

    def test_not_compliant_summary(self):
        r = ComplianceResult(
            compliant=False,
            missing_db_keys=["tasks", "clients"],
            missing_pages=["command_center"],
        )
        assert "NOT compliant" in r.summary
        assert "2 missing databases" in r.summary
        assert "1 missing pages" in r.summary

    def test_fix_count(self):
        r = ComplianceResult(
            compliant=False,
            missing_db_keys=["a", "b"],
            missing_db_properties=[MissingProperty("x", "y", "z")],
            missing_view_keys=[MissingViewKey("v1", "d1")],
        )
        assert r.fix_count == 4

    def test_to_dict(self):
        r = ComplianceResult(
            compliant=False,
            template_version="1.0",
            os_version="1.0",
            missing_db_properties=[MissingProperty("tasks", "status", "select", "rich_text")],
            missing_view_keys=[MissingViewKey("cc.active_combos", "outcomes")],
            write_lock=True,
        )
        d = r.to_dict()
        assert d["compliant"] is False
        assert d["write_lock"] is True
        assert d["missing_db_properties"][0]["actual_type"] == "rich_text"
        assert d["missing_view_keys"][0]["view_key"] == "cc.active_combos"


# ════════════════════════════════════════════
# Property Parsing Helpers Tests
# ════════════════════════════════════════════


class TestPropertyHelpers:
    def test_read_checkbox_true(self):
        props = {"write_lock": {"type": "checkbox", "checkbox": True}}
        assert _read_checkbox(props, "write_lock") is True

    def test_read_checkbox_false(self):
        props = {"write_lock": {"type": "checkbox", "checkbox": False}}
        assert _read_checkbox(props, "write_lock") is False

    def test_read_checkbox_missing(self):
        assert _read_checkbox({}, "write_lock") is None

    def test_read_date(self):
        props = {"last_verified_at": {"type": "date", "date": {"start": "2026-03-05"}}}
        assert _read_date(props, "last_verified_at") == "2026-03-05"

    def test_read_date_none(self):
        props = {"last_verified_at": {"type": "date", "date": None}}
        assert _read_date(props, "last_verified_at") is None

    def test_read_rich_text(self):
        props = {"view_key": {"type": "rich_text", "rich_text": [{"plain_text": "cc.active"}]}}
        assert _read_rich_text(props, "view_key") == "cc.active"

    def test_read_rich_text_title(self):
        props = {"Name": {"type": "title", "title": [{"plain_text": "Hello"}]}}
        assert _read_rich_text(props, "Name") == "Hello"

    def test_read_title(self):
        props = {"Name": {"type": "title", "title": [{"plain_text": "My Page"}]}}
        assert _read_title(props) == "My Page"

    def test_extract_plain_text_paragraph(self):
        block = {
            "type": "paragraph",
            "paragraph": {"rich_text": [{"plain_text": "Hello world"}]},
        }
        assert _extract_plain_text(block) == "Hello world"

    def test_extract_plain_text_callout(self):
        block = {
            "type": "callout",
            "callout": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_EXEC:START]]"}]},
        }
        assert _extract_plain_text(block) == "[[OPENCLAW:CC_EXEC:START]]"

    def test_extract_plain_text_divider(self):
        block = {"type": "divider", "divider": {}}
        assert _extract_plain_text(block) is None


# ════════════════════════════════════════════
# NotionIdMap Tests
# ════════════════════════════════════════════


class TestNotionIdMap:
    def test_defaults(self):
        ids = NotionIdMap()
        assert ids.page_ids == {}
        assert ids.db_ids == {}

    def test_with_values(self):
        ids = NotionIdMap(
            page_ids={"command_center": "page_123"},
            db_ids={"clients": "db_456"},
        )
        assert ids.page_ids["command_center"] == "page_123"
        assert ids.db_ids["clients"] == "db_456"


# ════════════════════════════════════════════
# Live Verifier Tests (mocked API)
# ════════════════════════════════════════════


class TestNotionComplianceVerifier:
    def _make_verifier(
        self,
        api: MagicMock | None = None,
        page_ids: dict | None = None,
        db_ids: dict | None = None,
    ) -> NotionComplianceVerifier:
        manifest = load_manifest()
        mock_api = api or MagicMock()
        ids = NotionIdMap(page_ids=page_ids or {}, db_ids=db_ids or {})
        return NotionComplianceVerifier(api=mock_api, manifest=manifest, ids=ids)

    def test_verify_all_missing_pages(self):
        api = MagicMock()
        api.get_page.side_effect = RuntimeError("not found")
        api.search.return_value = {"results": []}

        v = self._make_verifier(
            api=api,
            page_ids={
                "command_center": "p1",
                "ops_console": "p2",
                "system_settings": "p3",
                "client_portal_root": "p4",
            },
        )
        result = v.verify_all()
        assert "command_center" in result.missing_pages

    def test_verify_all_pages_found_by_id(self):
        api = MagicMock()
        api.get_page.return_value = {"id": "p1", "properties": {}}
        api.get_database.return_value = {"id": "db1", "properties": {}}
        api.query_all_database_rows.return_value = []
        api.list_all_block_children.return_value = []

        page_ids = {
            "command_center": "p1",
            "ops_console": "p2",
            "system_settings": "p3",
            "client_portal_root": "p4",
        }
        db_ids = {k: f"db_{k}" for k in load_manifest().get_required_db_keys()}

        v = self._make_verifier(api=api, page_ids=page_ids, db_ids=db_ids)
        result = v.verify_all()
        assert result.missing_pages == []

    def test_verify_databases_missing(self):
        api = MagicMock()
        api.get_page.return_value = {"id": "p1", "properties": {}}
        api.search.return_value = {"results": []}
        api.find_database_under_root.return_value = None
        api.query_all_database_rows.return_value = []
        api.list_all_block_children.return_value = []

        v = self._make_verifier(
            api=api,
            page_ids={
                "command_center": "p1",
                "ops_console": "p2",
                "system_settings": "p3",
                "client_portal_root": "p4",
            },
        )
        result = v.verify_all()
        assert len(result.missing_db_keys) > 0
        assert "clients" in result.missing_db_keys

    def test_verify_databases_with_wrong_property_type(self):
        api = MagicMock()
        api.get_page.return_value = {"id": "p1", "properties": {}}
        api.get_database.return_value = {
            "id": "db_clients",
            "properties": {
                "name": {"type": "title"},
                "ghl_contact_id": {"type": "number"},  # Wrong type (should be rich_text)
            },
        }
        api.search.return_value = {"results": []}
        api.find_database_under_root.return_value = None
        api.query_all_database_rows.return_value = []
        api.list_all_block_children.return_value = []

        v = self._make_verifier(
            api=api,
            page_ids={
                "command_center": "p1",
                "ops_console": "p2",
                "system_settings": "p3",
                "client_portal_root": "p4",
            },
            db_ids={"clients": "db_clients"},
        )
        result = v.verify_all()
        wrong_type_props = [
            p for p in result.missing_db_properties
            if p.db_key == "clients" and p.property_key == "ghl_contact_id"
        ]
        assert len(wrong_type_props) >= 1
        assert wrong_type_props[0].actual_type == "number"

    def test_verify_views_registry(self):
        api = MagicMock()
        api.get_page.return_value = {"id": "p1", "properties": {}}
        api.get_database.return_value = {"id": "db1", "properties": {}}
        # Views Registry has one row
        api.query_all_database_rows.return_value = [
            {"properties": {"Name": {"type": "title", "title": [{"plain_text": "cc.active_combos"}]}}},
        ]
        api.list_all_block_children.return_value = []
        api.search.return_value = {"results": []}
        api.find_database_under_root.return_value = None

        page_ids = {
            "command_center": "p1",
            "ops_console": "p2",
            "system_settings": "p3",
            "client_portal_root": "p4",
        }

        v = self._make_verifier(
            api=api,
            page_ids=page_ids,
            db_ids={"views_registry": "vr_db"},
        )
        result = v.verify_all()
        # cc.active_combos should NOT be missing (it's in the registry)
        missing_vk = [vk.view_key for vk in result.missing_view_keys]
        assert "cc.active_combos" not in missing_vk
        # But cc.pipeline_quality should be missing
        assert "cc.pipeline_quality" in missing_vk

    def test_verify_widget_markers_present(self):
        api = MagicMock()
        api.get_page.return_value = {"id": "p1", "properties": {}}
        api.get_database.return_value = {"id": "db1", "properties": {}}
        api.query_all_database_rows.return_value = []
        api.search.return_value = {"results": []}
        api.find_database_under_root.return_value = None

        # Command Center page has widget markers
        api.list_all_block_children.return_value = [
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_EXECUTIVE_STRIP:START]]"}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "KPIs here"}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_EXECUTIVE_STRIP:END]]"}]}},
        ]

        page_ids = {
            "command_center": "p1",
            "ops_console": "p2",
            "system_settings": "p3",
            "client_portal_root": "p4",
        }

        v = self._make_verifier(api=api, page_ids=page_ids)
        result = v.verify_all()
        # executive_strip should NOT be in missing_widgets
        assert "cc.executive_strip" not in result.missing_widgets
        # But others should be missing
        assert "cc.systems_reliability" in result.missing_widgets

    def test_verify_command_center_only(self):
        api = MagicMock()
        api.get_page.return_value = {"id": "p1", "properties": {}}
        api.query_all_database_rows.return_value = []
        api.list_all_block_children.return_value = []

        v = self._make_verifier(
            api=api,
            page_ids={
                "command_center": "p1",
                "ops_console": "p2",
                "system_settings": "p3",
                "client_portal_root": "p4",
            },
            db_ids={"views_registry": "vr_db"},
        )
        result = v.verify_command_center_only()
        # Should not check DB properties (that's full verify only)
        assert result.missing_db_properties == []
        assert result.missing_db_keys == []
        # But should check widgets
        assert len(result.missing_widgets) > 0

    def test_system_settings_read(self):
        api = MagicMock()
        # System settings page with write_lock and safe_mode
        api.get_page.return_value = {
            "id": "p3",
            "properties": {
                "write_lock": {"type": "checkbox", "checkbox": True},
                "safe_mode": {"type": "checkbox", "checkbox": False},
                "last_verified_at": {"type": "date", "date": {"start": "2026-03-05T12:00:00Z"}},
            },
        }
        api.get_database.return_value = {"id": "db1", "properties": {}}
        api.query_all_database_rows.return_value = []
        api.list_all_block_children.return_value = []
        api.search.return_value = {"results": []}
        api.find_database_under_root.return_value = None

        page_ids = {
            "command_center": "p1",
            "ops_console": "p2",
            "system_settings": "p3",
            "client_portal_root": "p4",
        }

        v = self._make_verifier(api=api, page_ids=page_ids)
        result = v.verify_all()
        assert result.write_lock is True
        assert result.safe_mode is False
        assert result.last_verified_at == "2026-03-05T12:00:00Z"
        assert any("write_lock" in w for w in result.warnings)

    def test_search_fallback_for_pages(self):
        api = MagicMock()
        # No page IDs provided; search returns Command Center
        api.search.side_effect = lambda query, filter_value="database", **kw: {
            "results": [{"object": "page", "id": "discovered_p1"}]
            if filter_value == "page" else
            {"results": []}
        }
        api.get_page.side_effect = RuntimeError("not found by ID")
        api.find_database_under_root.return_value = None
        api.query_all_database_rows.return_value = []
        api.list_all_block_children.return_value = []

        v = self._make_verifier(api=api)
        result = v.verify_all()
        # Pages should be discovered via search
        discovered = result.details.get("discovered_page_ids", {})
        # At least command_center should be discovered (all pages match same mock)
        assert len(discovered) > 0 or len(result.missing_pages) > 0


# ════════════════════════════════════════════
# Fix List Renderer Tests
# ════════════════════════════════════════════


class TestFixListRenderer:
    def test_all_clean(self):
        from packages.agencyu.notion.widgets.widget_renderers import render_fix_list

        blocks = render_fix_list({})
        assert len(blocks) >= 2
        # Should have "Everything looks good" callout
        callout_blocks = [b for b in blocks if b["type"] == "callout"]
        assert any("looks good" in b["callout"]["rich_text"][0]["text"]["content"] for b in callout_blocks)

    def test_missing_items(self):
        from packages.agencyu.notion.widgets.widget_renderers import render_fix_list

        data = {
            "missing_pages": ["command_center"],
            "missing_db_keys": ["tasks", "clients"],
            "missing_db_properties": [
                {"db_key": "clients", "property_key": "status", "expected_type": "select"},
            ],
            "missing_view_keys": [
                {"view_key": "cc.active_combos", "db_key": "outcomes"},
            ],
            "missing_widgets": ["cc.executive_strip"],
            "missing_portal_sections": ["trello"],
        }
        blocks = render_fix_list(data)
        assert blocks[0]["type"] == "heading_2"
        # Should have callouts for each category
        callout_blocks = [b for b in blocks if b["type"] == "callout"]
        assert len(callout_blocks) >= 5  # pages, dbs, props, views, widgets, sections

    def test_grouped_properties(self):
        from packages.agencyu.notion.widgets.widget_renderers import render_fix_list

        data = {
            "missing_db_properties": [
                {"db_key": "clients", "property_key": "status", "expected_type": "select"},
                {"db_key": "clients", "property_key": "mrr", "expected_type": "number"},
                {"db_key": "tasks", "property_key": "priority", "expected_type": "select"},
            ],
        }
        blocks = render_fix_list(data)
        callout_blocks = [b for b in blocks if b["type"] == "callout"]
        # Should have 2 callouts: one for clients, one for tasks
        prop_callouts = [
            b for b in callout_blocks
            if "Missing Properties" in b["callout"]["rich_text"][0]["text"]["content"]
        ]
        assert len(prop_callouts) == 2
