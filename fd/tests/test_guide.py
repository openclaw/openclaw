"""Tests for the OpenClaw Guide Engine."""

from __future__ import annotations

from openclaw.guide.capabilities import (
    CAPABILITIES,
    get_section,
    list_sections,
    search_capabilities,
)
from openclaw.guide.contextual_help import ContextualHelpProvider, HELP_SECTIONS
from openclaw.guide.engine import OpenClawGuideEngine
from openclaw.guide.explain import explain_action
from openclaw.guide.howto import HowToPlanner
from openclaw.guide.prompts import (
    format_contextual_help,
    format_howto,
    format_possibility,
    format_section_description,
    format_walkthrough_step,
)
from openclaw.guide.walkthrough import WalkthroughEngine
from openclaw.guide.adapters.telegram import handle_help, handle_guide, route_command
from openclaw.guide.adapters.ui import (
    get_panel_info,
    get_all_panel_info,
    get_prompt_bar_config,
    get_walkthrough,
)
from openclaw.guide.adapters.notion import generate_guide_blocks, generate_guide_markdown


# ── Capabilities ──────────────────────────────────────────────────────

class TestCapabilities:
    def test_all_sections_have_required_keys(self):
        required = {"name", "description", "can_do", "common_prompts", "requires_approval"}
        for key, section in CAPABILITIES.items():
            assert required.issubset(section.keys()), f"{key} missing keys"

    def test_get_section(self):
        assert get_section("command_center") is not None
        assert get_section("nonexistent") is None

    def test_list_sections(self):
        keys = list_sections()
        assert "command_center" in keys
        assert "finance" in keys
        assert "marketing" in keys

    def test_search_capabilities(self):
        results = search_capabilities("grant")
        assert len(results) >= 1
        assert any(r["key"] == "grantops" for r in results)

    def test_search_no_match(self):
        results = search_capabilities("xyznonexistent123")
        assert results == []


# ── Guide Engine ──────────────────────────────────────────────────────

class TestGuideEngine:
    def setup_method(self):
        self.engine = OpenClawGuideEngine()

    def test_describe_section_success(self):
        result = self.engine.describe_section("command_center")
        assert result["ok"] is True
        assert result["title"] == "Command Center"
        assert "can_do" in result

    def test_describe_section_missing(self):
        result = self.engine.describe_section("nonexistent")
        assert result["ok"] is False

    def test_is_possible_grant(self):
        result = self.engine.is_possible("Can you find grants?")
        assert result["ok"] is True
        assert result["possible"] is True

    def test_is_possible_scale_ads(self):
        result = self.engine.is_possible("Can I scale ads?")
        assert result["possible"] is True

    def test_is_possible_unknown(self):
        result = self.engine.is_possible("Can you fly a spaceship?")
        assert result["ok"] is True
        assert result["possible"] is False

    def test_what_can_i_do(self):
        result = self.engine.what_can_i_do("marketing")
        assert result["ok"] is True
        assert "Marketing" in result["message"]

    def test_what_can_i_do_missing(self):
        result = self.engine.what_can_i_do("nonexistent")
        assert result["ok"] is False

    def test_howto(self):
        result = self.engine.howto("start_day")
        assert result["ok"] is True
        assert "steps" in result

    def test_walkthrough(self):
        steps = self.engine.get_walkthrough()
        assert len(steps) > 0
        assert steps[0]["title"] == "Welcome to OpenClaw"

    def test_walkthrough_step(self):
        step = self.engine.get_walkthrough_step(0)
        assert step is not None
        assert step["step"] == 1

    def test_walkthrough_step_out_of_range(self):
        step = self.engine.get_walkthrough_step(999)
        assert step is None

    def test_contextual_help(self):
        result = self.engine.get_contextual_help("today_panel")
        assert result["ok"] is True

    def test_list_panels(self):
        panels = self.engine.list_panels()
        assert "today_panel" in panels
        assert "marketing_panel" in panels


# ── HowTo Planner ────────────────────────────────────────────────────

class TestHowToPlanner:
    def setup_method(self):
        self.planner = HowToPlanner()

    def test_exact_key(self):
        result = self.planner.get_plan("start_day")
        assert result["ok"] is True
        assert len(result["steps"]) > 0

    def test_alias(self):
        result = self.planner.get_plan("morning routine")
        assert result["ok"] is True
        assert result["title"] == "How to start the day"

    def test_missing(self):
        result = self.planner.get_plan("fly to mars")
        assert result["ok"] is False

    def test_list_topics(self):
        topics = self.planner.list_topics()
        assert len(topics) > 0

    def test_search(self):
        results = self.planner.search("grant")
        assert len(results) >= 1


# ── Walkthrough Engine ───────────────────────────────────────────────

class TestWalkthroughEngine:
    def setup_method(self):
        self.engine = WalkthroughEngine()

    def test_full_walkthrough(self):
        steps = self.engine.get_walkthrough()
        assert len(steps) == 11

    def test_total_steps(self):
        assert self.engine.total_steps() == 11

    def test_steps_for_section(self):
        steps = self.engine.get_steps_for_section("finance")
        assert len(steps) >= 1


# ── Contextual Help ──────────────────────────────────────────────────

class TestContextualHelp:
    def setup_method(self):
        self.provider = ContextualHelpProvider()

    def test_get_help(self):
        result = self.provider.get_help("today_panel")
        assert result["ok"] is True
        assert "prompts" in result

    def test_get_help_missing(self):
        result = self.provider.get_help("nonexistent")
        assert result["ok"] is False

    def test_tooltip(self):
        tooltip = self.provider.get_tooltip("today_panel")
        assert tooltip is not None
        assert len(tooltip) > 0

    def test_tooltip_missing(self):
        assert self.provider.get_tooltip("nonexistent") is None


# ── Explain ──────────────────────────────────────────────────────────

class TestExplain:
    def test_known_action(self):
        result = explain_action("scale ads")
        assert result["ok"] is True
        assert result["needs_approval"] is True

    def test_safe_action(self):
        result = explain_action("health check")
        assert result["ok"] is True
        assert result["needs_approval"] is False

    def test_unknown_action(self):
        result = explain_action("quantum teleport")
        assert result["ok"] is True


# ── Prompt Formatters ────────────────────────────────────────────────

class TestFormatters:
    def setup_method(self):
        self.engine = OpenClawGuideEngine()

    def test_format_section_description(self):
        data = self.engine.describe_section("finance")
        text = format_section_description(data)
        assert "Finance" in text

    def test_format_howto(self):
        data = self.engine.howto("start_day")
        text = format_howto(data)
        assert "start the day" in text.lower()

    def test_format_possibility(self):
        data = self.engine.is_possible("grants")
        text = format_possibility(data)
        assert len(text) > 0

    def test_format_walkthrough_step(self):
        step = self.engine.get_walkthrough_step(0)
        text = format_walkthrough_step(step)
        assert "Welcome" in text

    def test_format_contextual_help(self):
        data = self.engine.get_contextual_help("today_panel")
        text = format_contextual_help(data)
        assert "Today" in text


# ── Telegram Adapter ─────────────────────────────────────────────────

class TestTelegramAdapter:
    def test_help(self):
        text = handle_help()
        assert "/help" in text
        assert "/guide" in text

    def test_guide(self):
        text = handle_guide(0)
        assert "Welcome" in text

    def test_route_help(self):
        text = route_command("/help")
        assert "OpenClaw Guide" in text

    def test_route_guide(self):
        text = route_command("/guide")
        assert "Welcome" in text

    def test_route_howto(self):
        text = route_command("/howto start_day")
        assert "start the day" in text.lower()

    def test_route_whatcanido(self):
        text = route_command("/whatcanido marketing")
        assert "Marketing" in text

    def test_route_unknown(self):
        text = route_command("hello")
        assert text == ""


# ── UI Adapter ───────────────────────────────────────────────────────

class TestUIAdapter:
    def test_panel_info(self):
        result = get_panel_info("today_panel")
        assert result["ok"] is True

    def test_all_panel_info(self):
        result = get_all_panel_info()
        assert "today_panel" in result
        assert "marketing_panel" in result

    def test_prompt_bar_config(self):
        config = get_prompt_bar_config()
        assert "placeholder" in config
        assert len(config["suggestions"]) > 0

    def test_walkthrough(self):
        steps = get_walkthrough()
        assert len(steps) == 11


# ── Notion Adapter ───────────────────────────────────────────────────

class TestNotionAdapter:
    def test_generate_blocks(self):
        blocks = generate_guide_blocks("command_center")
        assert len(blocks) > 0
        assert blocks[0]["type"] == "divider"

    def test_generate_blocks_missing(self):
        blocks = generate_guide_blocks("nonexistent")
        assert blocks == []

    def test_generate_markdown(self):
        md = generate_guide_markdown("finance")
        assert "financial" in md.lower()
        assert "What this page does" in md

    def test_generate_markdown_missing(self):
        md = generate_guide_markdown("nonexistent")
        assert md == ""
