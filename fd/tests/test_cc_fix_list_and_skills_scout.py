"""Tests for cc.fix_list widget, WidgetWriter, cc_fix_list_writer, Skills Scout v2,
cc.skills_recommendations widget, skills backlog writer, checklist template, and fork workflow."""
from __future__ import annotations

import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from packages.agencyu.notion.compliance_models import (
    ComplianceResult,
    MissingProperty,
    MissingViewKey,
)


# ════════════════════════════════════════════
# cc.fix_list — FixItem + renderer
# ════════════════════════════════════════════


class TestFixItem:
    def test_build_fix_items_empty(self):
        from packages.agencyu.notion.widgets.cc_fix_list import build_fix_items

        result = ComplianceResult()
        items = build_fix_items(result)
        assert items == []

    def test_build_fix_items_all_categories(self):
        from packages.agencyu.notion.widgets.cc_fix_list import build_fix_items

        result = ComplianceResult(
            missing_pages=["command_center"],
            missing_db_keys=["tasks"],
            missing_db_properties=[MissingProperty("clients", "status", "select")],
            missing_view_keys=[MissingViewKey("cc.active_combos", "outcomes")],
            missing_widgets=["cc.executive_strip"],
            missing_portal_sections=["start_here"],
        )
        items = build_fix_items(result)
        assert len(items) == 6
        categories = {i.category for i in items}
        assert categories == {"pages", "databases", "properties", "views", "widgets", "portal_sections"}

    def test_fix_item_with_type_mismatch(self):
        from packages.agencyu.notion.widgets.cc_fix_list import build_fix_items

        result = ComplianceResult(
            missing_db_properties=[MissingProperty("clients", "status", "select", "rich_text")],
        )
        items = build_fix_items(result)
        assert len(items) == 1
        assert "got rich_text" in items[0].detail

    def test_fix_item_frozen(self):
        from packages.agencyu.notion.widgets.cc_fix_list import FixItem

        item = FixItem(category="pages", key="cc", detail="test", repair_hint="fix it")
        with pytest.raises(AttributeError):
            item.category = "other"


class TestRenderFixListBlocks:
    def test_empty_result(self):
        from packages.agencyu.notion.widgets.cc_fix_list import render_fix_list_blocks

        result = ComplianceResult()
        blocks = render_fix_list_blocks(result)
        assert blocks[0]["type"] == "heading_2"
        callouts = [b for b in blocks if b.get("type") == "callout"]
        assert any("looks good" in b["callout"]["rich_text"][0]["text"]["content"] for b in callouts)

    def test_blocks_with_missing_items(self):
        from packages.agencyu.notion.widgets.cc_fix_list import render_fix_list_blocks

        result = ComplianceResult(
            missing_pages=["command_center", "ops_console"],
            missing_db_keys=["tasks"],
            missing_widgets=["cc.executive_strip"],
        )
        blocks = render_fix_list_blocks(result)
        assert blocks[0]["type"] == "heading_2"
        para_texts = [
            b["paragraph"]["rich_text"][0]["text"]["content"]
            for b in blocks if b.get("type") == "paragraph"
        ]
        assert any("4 items" in t for t in para_texts)

    def test_blocks_grouped_by_category(self):
        from packages.agencyu.notion.widgets.cc_fix_list import render_fix_list_blocks

        result = ComplianceResult(
            missing_pages=["p1"],
            missing_db_keys=["d1"],
        )
        blocks = render_fix_list_blocks(result)
        callouts = [b for b in blocks if b.get("type") == "callout"]
        texts = [b["callout"]["rich_text"][0]["text"]["content"] for b in callouts]
        assert any("Missing Pages" in t for t in texts)
        assert any("Missing Databases" in t for t in texts)

    def test_marker_key_constant(self):
        from packages.agencyu.notion.widgets.cc_fix_list import MARKER_KEY

        assert MARKER_KEY == "CC_FIX_LIST"


# ════════════════════════════════════════════
# WidgetWriter
# ════════════════════════════════════════════


class TestWidgetWriter:
    def _make_writer(self, page_id="page_123", write_lock=False):
        from packages.agencyu.notion.widgets.widget_writer import WidgetWriter
        from packages.common.db import connect, init_schema
        from packages.common.clock import utc_now_iso

        conn = connect(":memory:")
        init_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("write_lock", "true" if write_lock else "false", utc_now_iso()),
        )
        conn.commit()

        mock_api = MagicMock()
        return WidgetWriter(conn, mock_api, page_id), mock_api, conn

    def test_write_widget_dry_run(self):
        writer, api, _ = self._make_writer()
        api.list_all_block_children.return_value = []

        result = writer.write_widget(
            marker_key="CC_FIX_LIST",
            blocks=[{"type": "paragraph"}],
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["dry_run"] is True
        assert result["action"] == "seed"

    def test_write_widget_seed_new(self):
        writer, api, _ = self._make_writer()
        api.list_all_block_children.return_value = []

        result = writer.write_widget(
            marker_key="CC_FIX_LIST",
            blocks=[{"type": "paragraph"}],
            safe_mode=False,
        )
        assert result["ok"] is True
        assert result["action"] == "seed"
        api.append_block_children.assert_called_once()

    def test_write_widget_replace_existing(self):
        writer, api, _ = self._make_writer()
        api.list_all_block_children.return_value = [
            {"id": "blk_1", "type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_FIX_LIST:START]]"}]}},
            {"id": "blk_2", "type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "old content"}]}},
            {"id": "blk_3", "type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_FIX_LIST:END]]"}]}},
        ]

        result = writer.write_widget(
            marker_key="CC_FIX_LIST",
            blocks=[{"type": "paragraph"}],
            safe_mode=False,
        )
        assert result["ok"] is True
        assert result["action"] == "replace"
        api.delete_block.assert_called_once_with("blk_2")

    def test_write_widget_no_page_id(self):
        writer, _, _ = self._make_writer(page_id="")
        result = writer.write_widget(
            marker_key="CC_FIX_LIST",
            blocks=[],
            safe_mode=False,
        )
        assert result["ok"] is False

    def test_write_lock_forces_dry_run(self):
        writer, api, _ = self._make_writer(write_lock=True)
        api.list_all_block_children.return_value = []

        result = writer.write_widget(
            marker_key="CC_FIX_LIST",
            blocks=[{"type": "paragraph"}],
            safe_mode=False,
        )
        assert result["ok"] is True
        assert result["dry_run"] is True

    def test_ensure_markers_already_exists(self):
        writer, api, _ = self._make_writer()
        api.list_all_block_children.return_value = [
            {"id": "blk_1", "type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_FIX_LIST:START]]"}]}},
            {"id": "blk_2", "type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "[[OPENCLAW:CC_FIX_LIST:END]]"}]}},
        ]

        result = writer.ensure_markers("CC_FIX_LIST", safe_mode=False)
        assert result["ok"] is True
        assert result["action"] == "already_exists"

    def test_ensure_markers_seeds_new(self):
        writer, api, _ = self._make_writer()
        api.list_all_block_children.return_value = []

        result = writer.ensure_markers("CC_FIX_LIST", safe_mode=False)
        assert result["ok"] is True
        assert result["action"] == "seeded"
        api.append_block_children.assert_called_once()


# ════════════════════════════════════════════
# cc_fix_list_writer
# ════════════════════════════════════════════


class TestCcFixListWriter:
    def test_write_cc_fix_list_dry_run(self):
        from packages.agencyu.notion.widgets.cc_fix_list_writer import write_cc_fix_list
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

        result = write_cc_fix_list(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_123",
            compliance_result=ComplianceResult(missing_pages=["command_center"]),
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["dry_run"] is True

    def test_ensure_cc_fix_list_markers(self):
        from packages.agencyu.notion.widgets.cc_fix_list_writer import ensure_cc_fix_list_markers
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

        result = ensure_cc_fix_list_markers(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_123",
            safe_mode=False,
        )
        assert result["ok"] is True
        assert result["action"] == "seeded"


# ════════════════════════════════════════════
# Widget Registry — cc.fix_list + cc.skills_recommendations
# ════════════════════════════════════════════


class TestFixListRegistry:
    def test_fix_list_in_registry(self):
        from packages.agencyu.notion.widgets.widget_registry import WIDGET_BY_KEY, FIX_LIST

        assert "cc.fix_list" in WIDGET_BY_KEY
        assert FIX_LIST.renderer == "render_fix_list_widget"
        assert FIX_LIST.required_view_keys == []

    def test_fix_list_marker_key(self):
        from packages.agencyu.notion.widgets.widget_registry import FIX_LIST

        assert FIX_LIST.effective_marker_key == "CC_FIX_LIST"
        assert FIX_LIST.marker_start == "[[OPENCLAW:CC_FIX_LIST:START]]"
        assert FIX_LIST.marker_end == "[[OPENCLAW:CC_FIX_LIST:END]]"

    def test_fix_list_widget_renderer_dispatch(self):
        from packages.agencyu.notion.widgets.widget_renderers import render_widget
        from packages.agencyu.notion.widgets.widget_registry import FIX_LIST

        blocks = render_widget(FIX_LIST, {})
        assert len(blocks) >= 2


class TestSkillsRecommendationsRegistry:
    def test_skills_recommendations_in_registry(self):
        from packages.agencyu.notion.widgets.widget_registry import (
            WIDGET_BY_KEY, SKILLS_RECOMMENDATIONS,
        )

        assert "cc.skills_recommendations" in WIDGET_BY_KEY
        assert SKILLS_RECOMMENDATIONS.renderer == "render_skills_recommendations_widget"
        assert SKILLS_RECOMMENDATIONS.required_view_keys == []

    def test_skills_recommendations_marker_key(self):
        from packages.agencyu.notion.widgets.widget_registry import SKILLS_RECOMMENDATIONS

        assert SKILLS_RECOMMENDATIONS.effective_marker_key == "CC_SKILLS_RECOMMENDATIONS"
        assert SKILLS_RECOMMENDATIONS.marker_start == "[[OPENCLAW:CC_SKILLS_RECOMMENDATIONS:START]]"

    def test_skills_recommendations_renderer_dispatch(self):
        from packages.agencyu.notion.widgets.widget_renderers import render_widget
        from packages.agencyu.notion.widgets.widget_registry import SKILLS_RECOMMENDATIONS

        # No scout_report data -> renders empty state
        blocks = render_widget(SKILLS_RECOMMENDATIONS, {})
        assert len(blocks) >= 1


# ════════════════════════════════════════════
# Skills Scout v2 — Models
# ════════════════════════════════════════════


class TestSkillModels:
    def test_skill_candidate_defaults(self):
        from packages.agencyu.skills.models import SkillCandidate

        c = SkillCandidate(
            skill_key="test-skill",
            title="Test Skill",
            description="A test",
            source_key="test",
            source_url="https://example.com",
            trust_tier="community",
        )
        assert c.fit_score == 0.0
        assert c.risk_score == 0.0
        assert c.recommended_mode == "confirm_only"

    def test_scout_report_to_dict(self):
        from packages.agencyu.skills.models import ScoutReport, SkillCandidate

        c = SkillCandidate(
            skill_key="s1", title="S1", description="D",
            source_key="src", source_url="https://x.com", trust_tier="official",
        )
        report = ScoutReport(
            generated_at="2026-03-06T12:00:00Z",
            candidates=[c],
            top_full_digital=["s1"],
            top_cutmv=["s1"],
            do_not_install=[],
        )
        d = report.to_dict()
        assert d["generated_at"] == "2026-03-06T12:00:00Z"
        assert len(d["candidates"]) == 1
        assert d["candidates"][0]["skill_key"] == "s1"
        assert d["top_full_digital"] == ["s1"]


# ════════════════════════════════════════════
# Skills Scout v2 — Sources
# ════════════════════════════════════════════


class TestSkillSources:
    def test_load_config(self):
        from packages.agencyu.skills.scout_service import _load_config

        cfg = _load_config("config/skills_sources.yaml")
        assert "skills_scout" in cfg
        root = cfg["skills_scout"]
        assert root["enabled"] is True
        assert "github.com" in root["allow_domains"]

    def test_source_config_parsing(self):
        from packages.agencyu.skills.scout_sources import SourceConfig

        sc = SourceConfig(
            source_key="test",
            type="github_repo",
            trust_tier="official",
            notes="test source",
            repo="test/repo",
            base_path="skills",
        )
        assert sc.source_key == "test"
        assert sc.type == "github_repo"

    def test_allowlist_enforcement(self):
        from packages.agencyu.skills.scout_sources import SkillsScoutSources

        scout = SkillsScoutSources(
            allow_domains=["github.com", "api.github.com"],
        )
        # Should pass for allowed domain
        scout._assert_allowed("https://github.com/anthropics/skills")
        scout._assert_allowed("https://api.github.com/repos/test/repo")

        # Should fail for blocked domain
        with pytest.raises(ValueError, match="Blocked by allowlist"):
            scout._assert_allowed("https://evil.com/something")

    def test_parse_skill_md_frontmatter(self):
        from packages.agencyu.skills.scout_sources import _parse_skill_md

        md = """---
name: my-skill
description: Does cool things
---

# My Cool Skill

This skill is great.
"""
        result = _parse_skill_md(md)
        assert result["name"] == "my-skill"
        assert result["description"] == "Does cool things"
        assert result["title"] == "My Cool Skill"

    def test_parse_skill_md_no_frontmatter(self):
        from packages.agencyu.skills.scout_sources import _parse_skill_md

        md = "# Simple Skill\n\nJust a readme."
        result = _parse_skill_md(md)
        assert result.get("title") == "Simple Skill"
        assert "name" not in result

    def test_extract_probable_skill_names(self):
        from packages.agencyu.skills.scout_sources import _extract_probable_skill_names

        html = """
        <div>notion-portal-builder</div>
        <div>trello-sync</div>
        <div>stripe-billing-tool</div>
        <div>content</div>
        <div>ab</div>
        """
        names = _extract_probable_skill_names(html)
        assert "notion-portal-builder" in names
        assert "trello-sync" in names
        assert "stripe-billing-tool" in names
        # "content" has no hyphen -> excluded (prefers hyphenated)
        # "ab" too short -> excluded

    def test_github_scan_with_mock(self):
        from packages.agencyu.skills.scout_sources import SkillsScoutSources, SourceConfig

        scout = SkillsScoutSources(
            allow_domains=["api.github.com", "raw.githubusercontent.com"],
        )

        # Mock _fetch_text to return GitHub API listing + SKILL.md
        api_response = json.dumps([
            {"name": "my-skill", "type": "dir"},
            {"name": "readme.md", "type": "file"},
        ])
        skill_md = """---
name: my-skill
description: A test skill
---

# My Skill
"""

        call_count = {"n": 0}
        originals = {}

        def mock_fetch(url):
            call_count["n"] += 1
            if "api.github.com" in url:
                return api_response
            if "raw.githubusercontent.com" in url:
                return skill_md
            return None

        scout._fetch_text = mock_fetch

        source = SourceConfig(
            source_key="test",
            type="github_repo",
            trust_tier="official",
            notes="test",
            repo="anthropics/skills",
            base_path="skills",
        )
        candidates = scout._scan_github_repo(source)
        assert len(candidates) == 1
        assert candidates[0].skill_key == "my-skill"
        assert candidates[0].trust_tier == "official"
        assert candidates[0].raw_snippet is not None


# ════════════════════════════════════════════
# Skills Scout v2 — Ranker
# ════════════════════════════════════════════


class TestSkillRanker:
    def _make_candidate(self, title="Test", desc="", snippet=None, trust="community"):
        from packages.agencyu.skills.models import SkillCandidate

        return SkillCandidate(
            skill_key="test-skill",
            title=title,
            description=desc,
            source_key="test",
            source_url="https://example.com",
            trust_tier=trust,
            raw_snippet=snippet,
        )

    def test_fit_score_with_keywords(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(
            fit_profile={
                "full_digital": {"weight": 1.0, "keywords": ["trello", "notion", "crm"]},
                "cutmv": {"weight": 1.0, "keywords": ["stripe", "analytics"]},
            },
            risk_rules={"high_risk_markers": []},
        )
        c = self._make_candidate(
            title="Trello Notion CRM Integration",
            desc="Sync trello boards with notion databases",
        )
        score = ranker._fit_score(c)
        assert score > 0.0

    def test_fit_score_official_boost(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(
            fit_profile={"fd": {"weight": 1.0, "keywords": ["notion"]}},
            risk_rules={"high_risk_markers": []},
        )
        community = self._make_candidate(title="Notion Tool", trust="community")
        official = self._make_candidate(title="Notion Tool", trust="official")

        c_score = ranker._fit_score(community)
        o_score = ranker._fit_score(official)
        assert o_score > c_score

    def test_risk_score_with_markers(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(
            fit_profile={},
            risk_rules={"high_risk_markers": ["rm -rf", "eval(", "token"]},
        )
        c = self._make_candidate(
            title="Cleanup Tool",
            desc="Uses eval( to process",
            snippet="rm -rf /tmp/cache\ntoken = os.environ['API_KEY']",
        )
        score = ranker._risk_score(c)
        assert score >= 24.0  # 3 hits * 12.0 = 36.0

    def test_risk_score_official_reduction(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(
            fit_profile={},
            risk_rules={"high_risk_markers": ["delete"]},
        )
        community = self._make_candidate(desc="delete files", trust="community")
        official = self._make_candidate(desc="delete files", trust="official")

        c_risk = ranker._risk_score(community)
        o_risk = ranker._risk_score(official)
        assert o_risk < c_risk

    def test_recommend_mode_official(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(fit_profile={}, risk_rules={"high_risk_markers": []})
        c = self._make_candidate(trust="official")
        c.risk_score = 10.0
        assert ranker._recommend_mode(c) == "safe_then_confirm"

    def test_recommend_mode_high_risk(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(fit_profile={}, risk_rules={"high_risk_markers": []})
        c = self._make_candidate(trust="official")
        c.risk_score = 75.0
        assert ranker._recommend_mode(c) == "do_not_install"

    def test_recommend_mode_community_moderate_risk(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(fit_profile={}, risk_rules={"high_risk_markers": []})
        c = self._make_candidate(trust="community")
        c.risk_score = 45.0
        assert ranker._recommend_mode(c) == "do_not_install"

    def test_score_batch(self):
        from packages.agencyu.skills.scout_ranker import SkillsScoutRanker

        ranker = SkillsScoutRanker(
            fit_profile={"fd": {"weight": 1.0, "keywords": ["notion"]}},
            risk_rules={"high_risk_markers": ["delete"]},
        )
        c1 = self._make_candidate(title="Notion Tool", trust="official")
        c2 = self._make_candidate(title="Delete Everything", desc="delete all", trust="community")
        scored = ranker.score([c1, c2])
        assert scored[0].fit_score > 0  # c1 has notion keyword
        assert scored[1].risk_score > 0  # c2 has delete marker


# ════════════════════════════════════════════
# Skills Scout v2 — Report
# ════════════════════════════════════════════


class TestSkillReport:
    def _make_candidates(self):
        from packages.agencyu.skills.models import SkillCandidate

        c1 = SkillCandidate(
            skill_key="notion-sync",
            title="Notion Sync",
            description="Sync everything to Notion",
            source_key="official",
            source_url="https://github.com/anthropics/skills/notion-sync",
            trust_tier="official",
            fit_score=60.0,
            risk_score=5.0,
            recommended_mode="safe_then_confirm",
        )
        c2 = SkillCandidate(
            skill_key="risky-tool",
            title="Risky Tool",
            description="Deletes stuff with eval",
            source_key="community",
            source_url="https://example.com",
            trust_tier="community",
            fit_score=10.0,
            risk_score=80.0,
            recommended_mode="do_not_install",
        )
        return [c1, c2]

    def test_build_report(self):
        from packages.agencyu.skills.scout_report import build_report

        candidates = self._make_candidates()
        report = build_report(candidates)
        assert len(report.candidates) == 2
        assert "notion-sync" in report.top_full_digital
        assert "risky-tool" in report.do_not_install
        assert len(report.notes) >= 1

    def test_render_markdown(self):
        from packages.agencyu.skills.scout_report import build_report, render_markdown

        report = build_report(self._make_candidates())
        md = render_markdown(report)
        assert "# OpenClaw Skills Scout Report" in md
        assert "Notion Sync" in md
        assert "risky-tool" in md
        assert "advisory report" in md.lower()

    def test_write_report_files(self):
        from packages.agencyu.skills.scout_report import build_report, write_report_files

        report = build_report(self._make_candidates())

        with tempfile.TemporaryDirectory() as td:
            json_path = os.path.join(td, "out", "latest.json")
            md_path = os.path.join(td, "out", "latest.md")
            write_report_files(report, json_path=json_path, md_path=md_path)

            assert os.path.exists(json_path)
            assert os.path.exists(md_path)

            with open(json_path) as f:
                data = json.load(f)
            assert data["generated_at"] == report.generated_at
            assert len(data["candidates"]) == 2

    def test_empty_report(self):
        from packages.agencyu.skills.scout_report import build_report

        report = build_report([])
        assert len(report.candidates) == 0
        assert report.do_not_install == []


# ════════════════════════════════════════════
# Skills Scout v2 — Service
# ════════════════════════════════════════════


class TestScoutService:
    def test_load_config(self):
        from packages.agencyu.skills.scout_service import _load_config

        cfg = _load_config("config/skills_sources.yaml")
        root = cfg["skills_scout"]
        assert "sources" in root
        assert "fit_profile" in root
        assert "risk_rules" in root
        assert "output" in root

    def test_load_config_missing_file(self):
        from packages.agencyu.skills.scout_service import _load_config

        with pytest.raises(FileNotFoundError):
            _load_config("nonexistent.yaml")


# ════════════════════════════════════════════
# cc.skills_recommendations — Widget
# ════════════════════════════════════════════


class TestSkillsRecommendationsWidget:
    def _make_report(self, candidates=None, do_not_install=None):
        from packages.agencyu.skills.models import ScoutReport, SkillCandidate

        if candidates is None:
            candidates = [
                SkillCandidate(
                    skill_key="notion-sync",
                    title="Notion Sync",
                    description="Sync data",
                    source_key="official",
                    source_url="https://x.com",
                    trust_tier="official",
                    fit_score=50.0,
                    risk_score=5.0,
                    recommended_mode="safe_then_confirm",
                ),
            ]
        return ScoutReport(
            generated_at="2026-03-06T12:00:00Z",
            candidates=candidates,
            top_full_digital=["notion-sync"],
            top_cutmv=["notion-sync"],
            do_not_install=do_not_install or [],
        )

    def test_render_with_candidates(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import (
            render_skills_recommendations,
        )

        report = self._make_report()
        blocks = render_skills_recommendations(report)
        assert blocks[0]["type"] == "heading_2"
        # Should have bulleted list items for candidates
        bullet_blocks = [b for b in blocks if b.get("type") == "bulleted_list_item"]
        assert any("Notion Sync" in b["bulleted_list_item"]["rich_text"][0]["text"]["content"]
                    for b in bullet_blocks)

    def test_render_empty_candidates(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import (
            render_skills_recommendations,
        )

        report = self._make_report(candidates=[], do_not_install=[])
        blocks = render_skills_recommendations(report)
        callouts = [b for b in blocks if b.get("type") == "callout"]
        assert any("No safe recommendations" in b["callout"]["rich_text"][0]["text"]["content"]
                    for b in callouts)

    def test_render_do_not_install(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import (
            render_skills_recommendations,
        )
        from packages.agencyu.skills.models import SkillCandidate

        bad = SkillCandidate(
            skill_key="dangerous-tool",
            title="Dangerous",
            description="Bad",
            source_key="community",
            source_url="https://x.com",
            trust_tier="community",
            recommended_mode="do_not_install",
        )
        report = self._make_report(candidates=[bad], do_not_install=["dangerous-tool"])
        blocks = render_skills_recommendations(report)
        bullet_blocks = [b for b in blocks if b.get("type") == "bulleted_list_item"]
        texts = [b["bulleted_list_item"]["rich_text"][0]["text"]["content"] for b in bullet_blocks]
        assert any("dangerous-tool" in t for t in texts)

    def test_marker_key_constant(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import MARKER_KEY

        assert MARKER_KEY == "CC_SKILLS_RECOMMENDATIONS"

    def test_writer_dry_run(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations_writer import (
            write_cc_skills_recommendations,
        )
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

        report = self._make_report()
        result = write_cc_skills_recommendations(
            conn=conn,
            notion_api=api,
            command_center_page_id="page_123",
            report=report,
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["dry_run"] is True


# ════════════════════════════════════════════
# page_blocks — to_do builder
# ════════════════════════════════════════════


class TestToDoBlock:
    def test_to_do_unchecked(self):
        from packages.agencyu.notion.mirror.page_blocks import to_do

        block = to_do("Review SKILL.md")
        assert block["type"] == "to_do"
        assert block["to_do"]["checked"] is False
        assert block["to_do"]["rich_text"][0]["text"]["content"] == "Review SKILL.md"

    def test_to_do_checked(self):
        from packages.agencyu.notion.mirror.page_blocks import to_do

        block = to_do("Done", checked=True)
        assert block["to_do"]["checked"] is True


# ════════════════════════════════════════════
# Skills Backlog Writer
# ════════════════════════════════════════════


class TestSkillsBacklogWriter:
    def _make_candidate(self):
        from packages.agencyu.skills.models import SkillCandidate

        return SkillCandidate(
            skill_key="notion-sync",
            title="Notion Sync",
            description="Sync data to Notion",
            source_key="official",
            source_url="https://github.com/anthropics/skills/notion-sync",
            trust_tier="official",
            fit_score=65.0,
            risk_score=8.0,
            recommended_mode="safe_then_confirm",
        )

    def test_create_backlog_item(self):
        from packages.agencyu.notion.skills_backlog_writer import create_skills_backlog_item

        api = MagicMock()
        api.create_page.return_value = "page_abc123"

        candidate = self._make_candidate()
        result = create_skills_backlog_item(
            notion_api=api,
            database_id="db_skills_backlog",
            candidate=candidate,
            checklist_page_url="https://notion.so/checklist123",
            pain_point="Persistent Memory",
            notes="Memory-related skill.",
        )

        assert result["page_id"] == "page_abc123"
        assert "notion.so" in result["url"]

        # Verify create_page was called with correct parent
        call_args = api.create_page.call_args
        parent = call_args[0][0]
        props = call_args[0][1]
        assert parent["type"] == "database_id"
        assert parent["database_id"] == "db_skills_backlog"
        assert props["Name"]["title"][0]["text"]["content"] == "Notion Sync"
        assert props["skill_key"]["rich_text"][0]["text"]["content"] == "notion-sync"
        assert props["trust_tier"]["select"]["name"] == "official"
        assert props["fit_score"]["number"] == 65.0
        assert props["status"]["select"]["name"] == "Pending Review"
        assert props["pain_point"]["rich_text"][0]["text"]["content"] == "Persistent Memory"
        assert props["checklist_page_url"]["url"] == "https://notion.so/checklist123"

    def test_create_backlog_item_empty_optionals(self):
        from packages.agencyu.notion.skills_backlog_writer import create_skills_backlog_item

        api = MagicMock()
        api.create_page.return_value = "page_xyz"

        candidate = self._make_candidate()
        result = create_skills_backlog_item(
            notion_api=api,
            database_id="db_id",
            candidate=candidate,
        )

        assert result["page_id"] == "page_xyz"
        props = api.create_page.call_args[0][1]
        assert props["pain_point"]["rich_text"][0]["text"]["content"] == ""
        assert props["checklist_page_url"]["url"] is None


# ════════════════════════════════════════════
# Skills Checklist Template
# ════════════════════════════════════════════


class TestSkillsChecklistTemplate:
    def test_build_checklist_blocks(self):
        from packages.agencyu.notion.skills_checklist_template import _build_checklist_blocks

        blocks = _build_checklist_blocks(
            skill_key="notion-sync",
            title="Notion Sync",
            source_url="https://github.com/anthropics/skills/notion-sync",
            trust_tier="official",
            fit_score=65.0,
            risk_score=8.0,
            recommended_mode="safe_then_confirm",
            pain_point="Persistent Memory",
            notes="Review carefully.",
        )

        # Should have markers
        texts = [_extract_text(b) for b in blocks]
        assert any("OPENCLAW:SKILL_CHECKLIST_NOTION_SYNC:START" in t for t in texts)
        assert any("OPENCLAW:SKILL_CHECKLIST_NOTION_SYNC:END" in t for t in texts)

        # Should have to_do blocks
        todo_blocks = [b for b in blocks if b.get("type") == "to_do"]
        assert len(todo_blocks) >= 11  # 5 safety + 4 fork + 2 decision

        # Check safety review items
        todo_texts = [b["to_do"]["rich_text"][0]["text"]["content"] for b in todo_blocks]
        assert any("SKILL.md" in t for t in todo_texts)
        assert any("license" in t.lower() for t in todo_texts)
        assert any("APPROVE" in t for t in todo_texts)
        assert any("REJECT" in t for t in todo_texts)

    def test_create_checklist_page(self):
        from packages.agencyu.notion.skills_checklist_template import create_skill_checklist_page

        api = MagicMock()
        api.create_page.return_value = "page_checklist_123"

        result = create_skill_checklist_page(
            notion_api=api,
            root_page_id="root_page_id",
            skill_key="notion-sync",
            title="Notion Sync",
            source_url="https://github.com/anthropics/skills/notion-sync",
            trust_tier="official",
            fit_score=65.0,
            risk_score=8.0,
            recommended_mode="safe_then_confirm",
        )

        assert result["page_id"] == "page_checklist_123"
        assert "notion.so" in result["url"]

        # Verify page created under root
        parent = api.create_page.call_args[0][0]
        assert parent["type"] == "page_id"
        assert parent["page_id"] == "root_page_id"

        # Verify blocks appended
        api.append_block_children.assert_called_once()
        call_args = api.append_block_children.call_args
        assert call_args[0][0] == "page_checklist_123"
        blocks = call_args[0][1]
        assert len(blocks) > 10

    def test_marker_format(self):
        from packages.agencyu.notion.skills_checklist_template import _marker_start, _marker_end

        assert _marker_start("my.skill-v2") == "[[OPENCLAW:SKILL_CHECKLIST_MY_SKILL_V2:START]]"
        assert _marker_end("my.skill-v2") == "[[OPENCLAW:SKILL_CHECKLIST_MY_SKILL_V2:END]]"


# ════════════════════════════════════════════
# Memory pain-point tagging
# ════════════════════════════════════════════


class TestMemoryPainPoint:
    def _make_candidate(self, title="Test Skill", desc="", tags=None):
        from packages.agencyu.skills.models import SkillCandidate

        return SkillCandidate(
            skill_key="test-skill",
            title=title,
            description=desc,
            source_key="test",
            source_url="https://example.com",
            trust_tier="community",
            tags=tags or [],
        )

    def test_infer_memory_from_title(self):
        from services.webhook_gateway.routes.skills import _infer_pain_point

        c = self._make_candidate(title="Persistent Memory Manager")
        assert _infer_pain_point(c) == "Persistent Memory"

    def test_infer_memory_from_description(self):
        from services.webhook_gateway.routes.skills import _infer_pain_point

        c = self._make_candidate(desc="Long-term context persistence for agents")
        assert _infer_pain_point(c) == "Persistent Memory"

    def test_infer_memory_from_tags(self):
        from services.webhook_gateway.routes.skills import _infer_pain_point

        c = self._make_candidate(tags=["rag", "llm"])
        assert _infer_pain_point(c) == "Persistent Memory"

    def test_no_memory_tag(self):
        from services.webhook_gateway.routes.skills import _infer_pain_point

        c = self._make_candidate(title="Stripe Billing Tool", desc="Process payments")
        assert _infer_pain_point(c) == ""

    def test_infer_notes_with_pain_point(self):
        from services.webhook_gateway.routes.skills import _infer_notes

        c = self._make_candidate()
        notes = _infer_notes(c, "Persistent Memory")
        assert "Memory-related" in notes

    def test_infer_notes_official(self):
        from services.webhook_gateway.routes.skills import _infer_notes
        from packages.agencyu.skills.models import SkillCandidate

        c = SkillCandidate(
            skill_key="test",
            title="Test",
            description="",
            source_key="test",
            source_url="",
            trust_tier="official",
        )
        notes = _infer_notes(c, "")
        assert "Official source" in notes


# ════════════════════════════════════════════
# cc.skills_recommendations — Memory section
# ════════════════════════════════════════════


class TestSkillsWidgetMemorySection:
    def test_memory_section_rendered(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import (
            render_skills_recommendations,
        )
        from packages.agencyu.skills.models import ScoutReport, SkillCandidate

        memory_skill = SkillCandidate(
            skill_key="memory-manager",
            title="Memory Manager",
            description="Persistent context for agents",
            source_key="official",
            source_url="https://x.com",
            trust_tier="official",
            fit_score=70.0,
            risk_score=5.0,
            recommended_mode="safe_then_confirm",
        )
        report = ScoutReport(
            generated_at="2026-03-06T12:00:00Z",
            candidates=[memory_skill],
            top_full_digital=["memory-manager"],
            top_cutmv=[],
            do_not_install=[],
        )
        blocks = render_skills_recommendations(report)
        h3_blocks = [b for b in blocks if b.get("type") == "heading_3"]
        h3_texts = [b["heading_3"]["rich_text"][0]["text"]["content"] for b in h3_blocks]
        assert "Memory candidates" in h3_texts

    def test_no_memory_section_without_match(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import (
            render_skills_recommendations,
        )
        from packages.agencyu.skills.models import ScoutReport, SkillCandidate

        normal_skill = SkillCandidate(
            skill_key="stripe-billing",
            title="Stripe Billing",
            description="Process payments",
            source_key="official",
            source_url="https://x.com",
            trust_tier="official",
            fit_score=50.0,
            risk_score=5.0,
            recommended_mode="safe_then_confirm",
        )
        report = ScoutReport(
            generated_at="2026-03-06T12:00:00Z",
            candidates=[normal_skill],
            top_full_digital=[],
            top_cutmv=[],
            do_not_install=[],
        )
        blocks = render_skills_recommendations(report)
        h3_blocks = [b for b in blocks if b.get("type") == "heading_3"]
        h3_texts = [b["heading_3"]["rich_text"][0]["text"]["content"] for b in h3_blocks]
        assert "Memory candidates" not in h3_texts

    def test_widget_next_actions_include_ui(self):
        from packages.agencyu.notion.widgets.cc_skills_recommendations import (
            render_skills_recommendations,
        )
        from packages.agencyu.skills.models import ScoutReport

        report = ScoutReport(
            generated_at="2026-03-06T12:00:00Z",
            candidates=[],
            top_full_digital=[],
            top_cutmv=[],
            do_not_install=[],
        )
        blocks = render_skills_recommendations(report)
        bullet_blocks = [b for b in blocks if b.get("type") == "bulleted_list_item"]
        texts = [b["bulleted_list_item"]["rich_text"][0]["text"]["content"] for b in bullet_blocks]
        assert any("/admin/skills/ui" in t for t in texts)


# ════════════════════════════════════════════
# Fork request endpoint
# ════════════════════════════════════════════


class TestForkRequestEndpoint:
    def test_find_candidate(self):
        from services.webhook_gateway.routes.skills import _find_candidate
        from packages.agencyu.skills.models import SkillCandidate

        c1 = SkillCandidate(
            skill_key="notion-sync",
            title="Notion Sync",
            description="",
            source_key="test",
            source_url="",
            trust_tier="official",
        )
        c2 = SkillCandidate(
            skill_key="stripe-tool",
            title="Stripe Tool",
            description="",
            source_key="test",
            source_url="",
            trust_tier="curated",
        )
        assert _find_candidate([c1, c2], "notion-sync") is c1
        assert _find_candidate([c1, c2], "stripe-tool") is c2
        assert _find_candidate([c1, c2], "nonexistent") is None

    def test_esc_html(self):
        from services.webhook_gateway.routes.skills import _esc

        assert _esc("<script>") == "&lt;script&gt;"
        assert _esc('a"b') == "a&quot;b"
        assert _esc("a&b") == "a&amp;b"


# ════════════════════════════════════════════
# Settings env vars
# ════════════════════════════════════════════


class TestSkillsSettings:
    def test_settings_have_skills_fields(self):
        from packages.common.config import Settings

        s = Settings(
            NOTION_DB_SKILLS_BACKLOG_ID="db_123",
            NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID="page_456",
        )
        assert s.NOTION_DB_SKILLS_BACKLOG_ID == "db_123"
        assert s.NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID == "page_456"

    def test_settings_default_empty(self):
        from packages.common.config import Settings

        s = Settings()
        assert s.NOTION_DB_SKILLS_BACKLOG_ID == ""
        assert s.NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID == ""


def _extract_text(block: dict) -> str:
    """Extract plain text from a Notion block."""
    btype = block.get("type", "")
    inner = block.get(btype, {})
    rt = inner.get("rich_text", [])
    if rt:
        return rt[0].get("text", {}).get("content", "")
    return ""
