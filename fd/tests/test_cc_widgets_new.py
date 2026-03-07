"""Tests for the 7 new CC widgets, view_links helper, and widget heal dispatcher."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest


# ════════════════════════════════════════════
# cc.kpis
# ════════════════════════════════════════════


class TestCcKpis:
    def test_render_empty_data(self):
        from packages.agencyu.notion.widgets.cc_kpis import render_cc_kpis

        blocks = render_cc_kpis({})
        assert blocks[0]["type"] == "heading_2"
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 6  # leads, calls booked, calls showed, sales, revenue, ad spend
        # All should show em-dash for missing data
        for b in bullets:
            text = b["bulleted_list_item"]["rich_text"][0]["text"]["content"]
            assert "\u2014" in text

    def test_render_with_data(self):
        from packages.agencyu.notion.widgets.cc_kpis import render_cc_kpis

        blocks = render_cc_kpis({"leads_today": 42, "revenue_today": "$5,000"})
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        texts = [b["bulleted_list_item"]["rich_text"][0]["text"]["content"] for b in bullets]
        assert any("42" in t for t in texts)
        assert any("$5,000" in t for t in texts)

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_kpis import MARKER_KEY

        assert MARKER_KEY == "CC_KPIS"


# ════════════════════════════════════════════
# cc.pipeline
# ════════════════════════════════════════════


class TestCcPipeline:
    def test_render_empty(self):
        from packages.agencyu.notion.widgets.cc_pipeline import render_cc_pipeline

        blocks = render_cc_pipeline({})
        assert blocks[0]["type"] == "heading_2"
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 6

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_pipeline import MARKER_KEY

        assert MARKER_KEY == "CC_PIPELINE"


# ════════════════════════════════════════════
# cc.cash
# ════════════════════════════════════════════


class TestCcCash:
    def test_render_empty(self):
        from packages.agencyu.notion.widgets.cc_cash import render_cc_cash

        blocks = render_cc_cash({})
        assert blocks[0]["type"] == "heading_2"
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 6

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_cash import MARKER_KEY

        assert MARKER_KEY == "CC_CASH"


# ════════════════════════════════════════════
# cc.calendar
# ════════════════════════════════════════════


class TestCcCalendar:
    def test_render_empty(self):
        from packages.agencyu.notion.widgets.cc_calendar import render_cc_calendar

        blocks = render_cc_calendar({})
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 4

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_calendar import MARKER_KEY

        assert MARKER_KEY == "CC_CALENDAR"


# ════════════════════════════════════════════
# cc.alerts
# ════════════════════════════════════════════


class TestCcAlerts:
    def test_render_no_alerts(self):
        from packages.agencyu.notion.widgets.cc_alerts import render_cc_alerts

        blocks = render_cc_alerts({"alerts": []})
        callouts = [b for b in blocks if b["type"] == "callout"]
        # Should have green "all clear" callout
        assert any(
            "All clear" in b["callout"]["rich_text"][0]["text"]["content"]
            for b in callouts
        )

    def test_render_with_alerts(self):
        from packages.agencyu.notion.widgets.cc_alerts import render_cc_alerts

        blocks = render_cc_alerts({"alerts": ["System X down", "Invoice overdue"]})
        callouts = [b for b in blocks if b["type"] == "callout"]
        assert any("2 alert" in b["callout"]["rich_text"][0]["text"]["content"] for b in callouts)
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 2

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_alerts import MARKER_KEY

        assert MARKER_KEY == "CC_ALERTS"


# ════════════════════════════════════════════
# cc.projects
# ════════════════════════════════════════════


class TestCcProjects:
    def test_render_empty(self):
        from packages.agencyu.notion.widgets.cc_projects import render_cc_projects

        blocks = render_cc_projects({})
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 4

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_projects import MARKER_KEY

        assert MARKER_KEY == "CC_PROJECTS"


# ════════════════════════════════════════════
# cc.quick_actions
# ════════════════════════════════════════════


class TestCcQuickActions:
    def test_render_no_links(self):
        from packages.agencyu.notion.widgets.cc_quick_actions import render_cc_quick_actions

        blocks = render_cc_quick_actions({"links": {}})
        paragraphs = [b for b in blocks if b["type"] == "paragraph"]
        texts = [b["paragraph"]["rich_text"][0]["text"]["content"] for b in paragraphs]
        assert any("No action links" in t for t in texts)

    def test_render_with_links(self):
        from packages.agencyu.notion.widgets.cc_quick_actions import render_cc_quick_actions

        blocks = render_cc_quick_actions({"links": {"Run heal": "/admin/heal", "Scan skills": "/admin/skills/scan"}})
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        assert len(bullets) == 2

    def test_marker_key(self):
        from packages.agencyu.notion.widgets.cc_quick_actions import MARKER_KEY

        assert MARKER_KEY == "CC_QUICK_ACTIONS"


# ════════════════════════════════════════════
# view_links
# ════════════════════════════════════════════


class TestViewLinks:
    def test_resolve_no_db_id(self):
        from packages.agencyu.notion.widgets.view_links import resolve_view_link

        api = MagicMock()
        result = resolve_view_link(api, "", "cc.kpis_today")
        assert result.ok is False
        assert "not configured" in result.note

    def test_resolve_not_found(self):
        from packages.agencyu.notion.widgets.view_links import resolve_view_link

        api = MagicMock()
        api.query_database.return_value = {"results": []}
        result = resolve_view_link(api, "views_db_123", "cc.kpis_today")
        assert result.ok is False
        assert "not registered" in result.note

    def test_resolve_found_with_page_id(self):
        from packages.agencyu.notion.widgets.view_links import resolve_view_link

        api = MagicMock()
        api.query_database.return_value = {
            "results": [{
                "properties": {
                    "view_key": {"rich_text": [{"plain_text": "cc.kpis_today"}]},
                    "page_id": {"rich_text": [{"plain_text": "abc-123"}]},
                },
                "url": "https://notion.so/row",
            }],
        }
        result = resolve_view_link(api, "views_db_123", "cc.kpis_today")
        assert result.ok is True
        assert "abc123" in result.page_url

    def test_render_view_links_blocks_mixed(self):
        from packages.agencyu.notion.widgets.view_links import ViewLink, render_view_links_blocks

        links = {
            "cc.active": ViewLink(view_key="cc.active", page_url="https://notion.so/p1", ok=True),
            "cc.missing": ViewLink(view_key="cc.missing", page_url=None, ok=False, note="not found"),
        }
        blocks = render_view_links_blocks(links)
        # Should have one bullet for found + one paragraph for missing
        bullets = [b for b in blocks if b["type"] == "bulleted_list_item"]
        paragraphs = [b for b in blocks if b["type"] == "paragraph"]
        assert len(bullets) == 1
        assert len(paragraphs) == 1
        assert "cc.missing" in paragraphs[0]["paragraph"]["rich_text"][0]["text"]["content"]


# ════════════════════════════════════════════
# Widget heal dispatcher
# ════════════════════════════════════════════


class TestWidgetHeal:
    def test_write_unknown_key(self):
        from packages.agencyu.notion.widgets.widget_heal import write_widget_by_key
        from packages.common.db import connect, init_schema

        conn = connect(":memory:")
        init_schema(conn)
        api = MagicMock()

        result = write_widget_by_key(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_cc",
            widget_key="cc.does_not_exist",
        )
        assert result["ok"] is False
        assert "unknown" in result["error"]

    def test_write_known_key_safe_mode(self):
        from packages.agencyu.notion.widgets.widget_heal import write_widget_by_key
        from packages.common.clock import utc_now_iso
        from packages.common.db import connect, init_schema

        conn = connect(":memory:")
        init_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("write_lock", "false", utc_now_iso()),
        )
        conn.commit()

        api = MagicMock()
        api.list_all_block_children.return_value = []

        result = write_widget_by_key(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_cc",
            widget_key="cc.kpis",
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["widget_key"] == "cc.kpis"
        assert result["result"]["dry_run"] is True

    def test_heal_missing_widgets(self):
        from packages.agencyu.notion.widgets.widget_heal import heal_missing_widgets
        from packages.common.clock import utc_now_iso
        from packages.common.db import connect, init_schema

        conn = connect(":memory:")
        init_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("write_lock", "false", utc_now_iso()),
        )
        conn.commit()

        api = MagicMock()
        api.list_all_block_children.return_value = []

        result = heal_missing_widgets(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_cc",
            missing_widget_keys=["cc.kpis", "cc.alerts", "cc.quick_actions"],
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["total"] == 3
        assert result["simulated"] == 3
        assert result["written"] == 0


# ════════════════════════════════════════════
# Widget registry — 16 widgets total
# ════════════════════════════════════════════


class TestWidgetRegistryExpanded:
    def test_all_new_keys_present(self):
        from packages.agencyu.notion.widgets.widget_registry import WIDGET_BY_KEY

        new_keys = ["cc.kpis", "cc.pipeline", "cc.cash", "cc.calendar",
                     "cc.alerts", "cc.projects", "cc.quick_actions"]
        for k in new_keys:
            assert k in WIDGET_BY_KEY, f"Missing widget: {k}"

    def test_all_new_renderers_in_map(self):
        from packages.agencyu.notion.widgets.widget_renderers import RENDERER_MAP

        new_renderers = [
            "render_cc_kpis_widget",
            "render_cc_pipeline_widget",
            "render_cc_cash_widget",
            "render_cc_calendar_widget",
            "render_cc_alerts_widget",
            "render_cc_projects_widget",
            "render_cc_quick_actions_widget",
        ]
        for r in new_renderers:
            assert r in RENDERER_MAP, f"Missing renderer: {r}"

    def test_renderer_map_count(self):
        from packages.agencyu.notion.widgets.widget_renderers import RENDERER_MAP

        assert len(RENDERER_MAP) == 16

    def test_marker_keys_unique(self):
        from packages.agencyu.notion.widgets.widget_registry import ALL_WIDGETS

        keys = [w.effective_marker_key for w in ALL_WIDGETS]
        assert len(keys) == len(set(keys)), f"Duplicate marker keys: {keys}"
