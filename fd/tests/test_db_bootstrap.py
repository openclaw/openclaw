"""Tests for DB bootstrap, Skills Backlog bootstrap, cc.db_registry widget, and admin endpoints."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest


# ════════════════════════════════════════════
# ensure_child_page
# ════════════════════════════════════════════


class TestEnsureChildPage:
    def test_safe_mode_returns_parent(self):
        from packages.agencyu.notion.db_bootstrap import ensure_child_page

        api = MagicMock()
        result = ensure_child_page(api, "parent_123", title="OpenClaw Databases", safe_mode=True)

        assert result.ok is True
        assert result.page_id == "parent_123"
        assert result.created is False
        api.create_page.assert_not_called()

    def test_apply_creates_page(self):
        from packages.agencyu.notion.db_bootstrap import ensure_child_page

        api = MagicMock()
        api.create_page.return_value = "new_page_456"

        result = ensure_child_page(api, "parent_123", title="OpenClaw Databases", safe_mode=False)

        assert result.ok is True
        assert result.page_id == "new_page_456"
        assert result.created is True
        assert result.page_url is not None

        # Verify create_page called with correct parent
        call_args = api.create_page.call_args
        parent = call_args[0][0]
        assert parent["type"] == "page_id"
        assert parent["page_id"] == "parent_123"


# ════════════════════════════════════════════
# Skills Backlog Bootstrap
# ════════════════════════════════════════════


class TestSkillsBacklogBootstrap:
    def _make_full_db(self):
        return {
            "id": "db_existing_123",
            "properties": {
                "Name": {"type": "title"},
                "skill_key": {"type": "rich_text"},
                "source_url": {"type": "url"},
                "trust_tier": {
                    "type": "select",
                    "options": ["official", "curated", "community", "unknown"],
                },
                "fit_score": {"type": "number"},
                "risk_score": {"type": "number"},
                "recommended_mode": {
                    "type": "select",
                    "options": ["safe_only", "safe_then_confirm", "confirm_only", "do_not_install"],
                },
                "status": {
                    "type": "select",
                    "options": ["New", "Reviewing", "Approved to Fork", "Forked", "Rejected"],
                },
                "pain_point": {"type": "multi_select", "options": ["Persistent Memory"]},
                "notes": {"type": "rich_text"},
                "checklist_page_url": {"type": "url"},
                "created_at": {"type": "date"},
                "last_updated_at": {"type": "date"},
            },
        }

    def test_existing_db_verifies(self):
        from packages.agencyu.notion.skills_backlog_bootstrap import bootstrap_skills_backlog_db

        api = MagicMock()
        api.get_database.return_value = self._make_full_db()

        result = bootstrap_skills_backlog_db(
            api,
            parent_page_id="parent_1",
            existing_db_id="db_existing_123",
            safe_mode=True,
        )

        assert result.ok is True
        assert result.created is False
        assert result.db_id == "db_existing_123"
        assert result.compliance is not None
        assert result.compliance["compliant"] is True
        api.create_database.assert_not_called()

    def test_missing_db_simulates(self):
        from packages.agencyu.notion.skills_backlog_bootstrap import bootstrap_skills_backlog_db

        api = MagicMock()
        api.get_database.side_effect = RuntimeError("404")

        result = bootstrap_skills_backlog_db(
            api,
            parent_page_id="parent_1",
            existing_db_id="db_missing",
            safe_mode=True,
        )

        assert result.ok is True
        assert result.mode == "simulate"
        assert result.created is False
        assert result.blocked_reason == "db_missing_simulated"
        api.create_database.assert_not_called()

    def test_missing_db_creates_on_apply(self):
        from packages.agencyu.notion.skills_backlog_bootstrap import bootstrap_skills_backlog_db

        api = MagicMock()
        api.get_database.side_effect = [
            RuntimeError("404"),  # first check: existing doesn't exist
            self._make_full_db(),  # after create: verify
        ]
        api.create_database.return_value = "db_new_789"

        result = bootstrap_skills_backlog_db(
            api,
            parent_page_id="parent_1",
            existing_db_id="db_missing",
            safe_mode=False,
        )

        assert result.ok is True
        assert result.mode == "apply"
        assert result.created is True
        assert result.db_id == "db_new_789"

        # Verify create_database was called
        call_args = api.create_database.call_args
        assert call_args[0][0] == "parent_1"  # parent_page_id
        payload = call_args[0][1]
        assert payload["title"] == "OpenClaw \u2014 Skills Backlog"
        assert "Name" in payload["properties"]
        assert "skill_key" in payload["properties"]
        assert "trust_tier" in payload["properties"]

    def test_no_existing_id_creates_on_apply(self):
        from packages.agencyu.notion.skills_backlog_bootstrap import bootstrap_skills_backlog_db

        api = MagicMock()
        api.get_database.return_value = self._make_full_db()
        api.create_database.return_value = "db_created"

        result = bootstrap_skills_backlog_db(
            api,
            parent_page_id="parent_1",
            existing_db_id=None,
            safe_mode=False,
        )

        assert result.ok is True
        assert result.created is True
        assert result.db_id == "db_created"

    def test_build_properties_payload(self):
        from packages.agencyu.notion.skills_backlog_bootstrap import _build_properties_payload

        props = _build_properties_payload()
        assert "Name" in props
        assert props["Name"] == {"title": {}}
        assert "skill_key" in props
        assert props["skill_key"] == {"rich_text": {}}
        assert "trust_tier" in props
        assert "select" in props["trust_tier"]
        assert len(props["trust_tier"]["select"]["options"]) == 4
        assert "pain_point" in props
        assert "multi_select" in props["pain_point"]


# ════════════════════════════════════════════
# cc.db_registry widget
# ════════════════════════════════════════════


class TestDbRegistryWidget:
    def test_render_db_missing(self):
        from packages.agencyu.notion.widgets.cc_db_registry import render_db_registry

        blocks = render_db_registry(
            db_root_page_url=None,
            skills_backlog={"exists": False},
        )
        assert blocks[0]["type"] == "heading_2"
        # Should have a red callout about MISSING
        callouts = [b for b in blocks if b.get("type") == "callout"]
        assert any("MISSING" in b["callout"]["rich_text"][0]["text"]["content"] for b in callouts)

    def test_render_db_exists_compliant(self):
        from packages.agencyu.notion.widgets.cc_db_registry import render_db_registry

        blocks = render_db_registry(
            db_root_page_url="https://notion.so/db-root",
            skills_backlog={
                "exists": True,
                "db_url": "https://notion.so/db123",
                "compliant": True,
                "missing_props_count": 0,
                "missing_options_count": 0,
            },
        )
        callouts = [b for b in blocks if b.get("type") == "callout"]
        assert any("COMPLIANT" in b["callout"]["rich_text"][0]["text"]["content"] for b in callouts)
        # Should have green background
        assert any(b["callout"].get("color") == "green_background" for b in callouts)

    def test_render_db_exists_not_compliant(self):
        from packages.agencyu.notion.widgets.cc_db_registry import render_db_registry

        blocks = render_db_registry(
            db_root_page_url=None,
            skills_backlog={
                "exists": True,
                "db_url": "https://notion.so/db123",
                "compliant": False,
                "missing_props_count": 3,
                "missing_options_count": 1,
            },
        )
        callouts = [b for b in blocks if b.get("type") == "callout"]
        assert any("NOT COMPLIANT" in b["callout"]["rich_text"][0]["text"]["content"] for b in callouts)
        # Should have bulleted items about missing counts
        bullets = [b for b in blocks if b.get("type") == "bulleted_list_item"]
        bullet_texts = [b["bulleted_list_item"]["rich_text"][0]["text"]["content"] for b in bullets]
        assert any("Missing props: 3" in t for t in bullet_texts)

    def test_render_db_root_url_shown(self):
        from packages.agencyu.notion.widgets.cc_db_registry import render_db_registry

        blocks = render_db_registry(
            db_root_page_url="https://notion.so/dbhome",
            skills_backlog={"exists": False},
        )
        paragraphs = [b for b in blocks if b.get("type") == "paragraph"]
        texts = [b["paragraph"]["rich_text"][0]["text"]["content"] for b in paragraphs]
        assert any("https://notion.so/dbhome" in t for t in texts)

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_db_registry import MARKER_KEY

        assert MARKER_KEY == "CC_DB_REGISTRY"


# ════════════════════════════════════════════
# cc.db_registry writer
# ════════════════════════════════════════════


class TestDbRegistryWriter:
    def test_dry_run(self):
        from packages.agencyu.notion.widgets.cc_db_registry_writer import write_cc_db_registry
        from packages.common.db import connect, init_schema
        from packages.common.clock import utc_now_iso

        conn = connect(":memory:")
        init_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("write_lock", "false", utc_now_iso()),
        )
        conn.commit()

        api = MagicMock()
        api.list_all_block_children.return_value = []

        result = write_cc_db_registry(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_cc",
            skills_backlog={"exists": True, "compliant": True},
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["dry_run"] is True


# ════════════════════════════════════════════
# Widget registry — cc.db_registry registered
# ════════════════════════════════════════════


class TestDbRegistryRegistration:
    def test_widget_in_registry(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS, WIDGET_BY_KEY

        keys = {w.widget_key for w in ALL_WIDGETS}
        assert "cc.db_registry" in keys
        assert "cc.db_registry" in WIDGET_BY_KEY

    def test_widget_count(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS

        assert len(ALL_WIDGETS) == 16

    def test_renderer_in_map(self):
        from packages.agencyu.notion.widgets.widget_renderers import RENDERER_MAP

        assert "render_db_registry_widget" in RENDERER_MAP


# ════════════════════════════════════════════
# Settings — NOTION_PAGE_DB_ROOT_ID
# ════════════════════════════════════════════


class TestDbRootSettings:
    def test_setting_exists(self):
        from packages.common.config import Settings

        s = Settings(NOTION_PAGE_DB_ROOT_ID="page_root_123")
        assert s.NOTION_PAGE_DB_ROOT_ID == "page_root_123"

    def test_setting_default_empty(self):
        from packages.common.config import Settings

        s = Settings()
        assert s.NOTION_PAGE_DB_ROOT_ID == ""


# ════════════════════════════════════════════
# Admin endpoint models
# ════════════════════════════════════════════


class TestAdminModels:
    def test_bootstrap_request_defaults(self):
        from services.webhook_gateway.routes.db_bootstrap import BootstrapRequest

        req = BootstrapRequest()
        assert req.safe_mode is True
        assert req.create_openclaw_db_home is True
        assert req.existing_db_id is None

    def test_render_request_defaults(self):
        from services.webhook_gateway.routes.db_bootstrap import RenderDbRegistryRequest

        req = RenderDbRegistryRequest()
        assert req.safe_mode is True
