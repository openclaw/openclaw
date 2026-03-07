"""UI adapter — renders guide content for the Command Center web UI.

Provides structured data that the frontend renders as info icons,
hover cards, tooltips, onboarding overlays, and the persistent prompt bar.
"""

from __future__ import annotations

from ..contextual_help import HELP_SECTIONS
from ..engine import OpenClawGuideEngine
from ..explain import explain_action

_engine = OpenClawGuideEngine()


# ------------------------------------------------------------------
# Info icon / hover card data
# ------------------------------------------------------------------

def get_panel_info(panel_key: str) -> dict:
    """Return info-icon content for a specific UI panel.

    The frontend renders this as a hover card with:
      - title
      - description
      - possible actions
      - suggested prompts
      - approval note
    """
    return _engine.get_contextual_help(panel_key)


def get_all_panel_info() -> dict[str, dict]:
    """Return info-icon content for all panels at once.

    Useful for the frontend to pre-load all help content on page load.
    """
    return {key: _engine.get_contextual_help(key) for key in _engine.list_panels()}


def get_tooltip(panel_key: str) -> str:
    """Return a one-line tooltip for a panel."""
    section = HELP_SECTIONS.get(panel_key)
    if not section:
        return ""
    return section["description"]


# ------------------------------------------------------------------
# Onboarding walkthrough overlay
# ------------------------------------------------------------------

def get_walkthrough() -> list[dict]:
    """Return all walkthrough steps for the onboarding overlay."""
    return _engine.get_walkthrough()


def get_walkthrough_step(index: int) -> dict | None:
    """Return a single walkthrough step."""
    return _engine.get_walkthrough_step(index)


def get_walkthrough_progress(current_step: int) -> dict:
    """Return progress info for the walkthrough overlay."""
    total = _engine.walkthrough_length()
    return {
        "current": current_step,
        "total": total,
        "percent": round((current_step / total) * 100) if total else 0,
        "is_complete": current_step >= total,
    }


# ------------------------------------------------------------------
# Prompt bar suggestions
# ------------------------------------------------------------------

PROMPT_BAR_SUGGESTIONS: list[str] = [
    "What should I focus on today?",
    "Can you find grants for Full Digital?",
    "How do I scale ads safely?",
    "What does this section do?",
    "Run the start of day routine.",
    "Check website health.",
    "Generate 3 CUTMV ad concepts.",
    "What needs my approval?",
]


def get_prompt_bar_config() -> dict:
    """Return configuration for the persistent prompt bar."""
    return {
        "placeholder": "Ask OpenClaw anything...",
        "suggestions": PROMPT_BAR_SUGGESTIONS,
        "help_text": "Type any question or request in plain English.",
    }


# ------------------------------------------------------------------
# Section description (for section headers)
# ------------------------------------------------------------------

def get_section_description(section_key: str) -> dict:
    """Return a section description for use in section headers."""
    return _engine.describe_section(section_key)


# ------------------------------------------------------------------
# "What happens if I..." responses
# ------------------------------------------------------------------

def get_action_explanation(action: str) -> dict:
    """Return an explanation of what an action does."""
    return explain_action(action)


# ------------------------------------------------------------------
# Full layout spec for Command Center
# ------------------------------------------------------------------

COMMAND_CENTER_LAYOUT: dict = {
    "header": {
        "prompt_bar": {
            "position": "top-center",
            "width": "60%",
            "component": "PromptBar",
            "config_key": "prompt_bar",
        },
        "simple_mode_toggle": {
            "position": "top-right",
            "component": "SimpleToggle",
        },
    },
    "panels": [
        {
            "key": "today_panel",
            "position": "main-left",
            "has_info_icon": True,
            "info_position": "top-right-of-panel",
        },
        {
            "key": "schedule_panel",
            "position": "main-left-below",
            "has_info_icon": True,
            "info_position": "top-right-of-panel",
        },
        {
            "key": "kpi_chips",
            "position": "main-right-top",
            "has_info_icon": True,
            "info_position": "top-right-of-panel",
        },
        {
            "key": "health_panel",
            "position": "main-right-middle",
            "has_info_icon": True,
            "info_position": "top-right-of-panel",
        },
        {
            "key": "approvals_panel",
            "position": "main-right-bottom",
            "has_info_icon": True,
            "info_position": "top-right-of-panel",
        },
    ],
}
