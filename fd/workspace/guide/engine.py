"""OpenClaw Guide Engine — answers what, how, and is-it-possible.

This is the main entry point for all guide interactions.  Adapters
(Telegram, UI, Notion) call methods here and get plain-English dicts
ready for rendering.
"""

from __future__ import annotations

from .capabilities import CAPABILITIES, search_capabilities
from .contextual_help import ContextualHelpProvider
from .howto import HowToPlanner
from .walkthrough import WalkthroughEngine


class OpenClawGuideEngine:
    """Central guide engine that composes all sub-systems."""

    def __init__(self) -> None:
        self._howto = HowToPlanner()
        self._walkthrough = WalkthroughEngine()
        self._contextual = ContextualHelpProvider()

    # ------------------------------------------------------------------
    # Section descriptions
    # ------------------------------------------------------------------

    def describe_section(self, section_key: str) -> dict:
        """Return a plain-English description of *section_key*."""
        section = CAPABILITIES.get(section_key)
        if not section:
            return {
                "ok": False,
                "message": "I don't have guide information for that section yet.",
            }

        result: dict = {
            "ok": True,
            "title": section["name"],
            "description": section["description"],
            "can_do": section["can_do"],
            "common_prompts": section["common_prompts"],
        }
        if section.get("requires_approval"):
            result["requires_approval"] = section["requires_approval"]
        return result

    # ------------------------------------------------------------------
    # "Is this possible?" checker
    # ------------------------------------------------------------------

    _POSSIBILITY_RULES: list[tuple[list[str], str, str]] = [
        (
            ["grant"],
            "Yes — OpenClaw can help find, score, draft, and track grant opportunities.",
            "I can scan for opportunities and build a priority list.",
        ),
        (
            ["scale ads", "increase budget", "raise budget"],
            "Yes — OpenClaw can analyze performance and prepare safe scaling actions.",
            "Sensitive budget changes still require approval.",
        ),
        (
            ["check cluster", "cluster health", "node status"],
            "Yes — OpenClaw can inspect health, node status, and shared workspace conditions.",
            "I can run a health check and summarize the results.",
        ),
        (
            ["generate ad", "create ad", "ad concept"],
            "Yes — OpenClaw can generate ad concepts, hooks, and creative briefs.",
            "Tell me the brand and I'll draft a few options.",
        ),
        (
            ["invoice", "billing"],
            "Yes — OpenClaw tracks invoices, payments, and billing status.",
            "I can show pending invoices and flag overdue ones.",
        ),
        (
            ["website health", "site health", "check site"],
            "Yes — OpenClaw monitors your sites and can generate repair plans.",
            "I can run a health check right now.",
        ),
        (
            ["onboard", "new client", "client setup"],
            "Yes — OpenClaw can guide you through client onboarding step by step.",
            "I'll walk you through the checklist.",
        ),
        (
            ["approval", "approve"],
            "Yes — OpenClaw routes sensitive actions for your approval before executing.",
            "You can approve via Telegram or the Command Center.",
        ),
    ]

    def is_possible(self, request: str) -> dict:
        """Check whether OpenClaw can do what the user is asking."""
        text = request.lower()

        for keywords, message, next_step in self._POSSIBILITY_RULES:
            if any(kw in text for kw in keywords):
                return {
                    "ok": True,
                    "possible": True,
                    "message": message,
                    "next_step": next_step,
                }

        # Fall back to capability search
        matches = search_capabilities(request)
        if matches:
            section = matches[0]
            return {
                "ok": True,
                "possible": True,
                "message": (
                    f"Yes — that sounds like it belongs in {section['name']}. "
                    f"{section['description']}"
                ),
                "next_step": f"Try asking: {section['common_prompts'][0]}",
            }

        return {
            "ok": True,
            "possible": False,
            "message": (
                "I'm not fully sure yet, but I can help break that down "
                "and tell you what parts are automatable."
            ),
        }

    # ------------------------------------------------------------------
    # How-to planner
    # ------------------------------------------------------------------

    def howto(self, topic: str) -> dict:
        """Return a step-by-step plan for *topic*."""
        return self._howto.get_plan(topic)

    # ------------------------------------------------------------------
    # Walkthrough
    # ------------------------------------------------------------------

    def get_walkthrough(self) -> list[dict]:
        """Return the full first-run walkthrough sequence."""
        return self._walkthrough.get_walkthrough()

    def get_walkthrough_step(self, index: int) -> dict | None:
        """Return a single walkthrough step by index."""
        return self._walkthrough.get_step(index)

    def walkthrough_length(self) -> int:
        """Return the total number of walkthrough steps."""
        return self._walkthrough.total_steps()

    # ------------------------------------------------------------------
    # Contextual help
    # ------------------------------------------------------------------

    def get_contextual_help(self, panel_key: str) -> dict:
        """Return contextual help for a specific UI panel."""
        return self._contextual.get_help(panel_key)

    def list_panels(self) -> list[str]:
        """Return all panel keys that have contextual help."""
        return self._contextual.list_panels()

    # ------------------------------------------------------------------
    # Convenience: "what can I do here?"
    # ------------------------------------------------------------------

    def what_can_i_do(self, section_key: str) -> dict:
        """Shorthand for operators asking 'what can I do here?'"""
        desc = self.describe_section(section_key)
        if not desc["ok"]:
            return desc

        lines = [f"You're in {desc['title']}."]
        lines.append(desc["description"])
        lines.append("")
        lines.append("Here's what OpenClaw can do here:")
        for action in desc["can_do"]:
            lines.append(f"  - {action}")

        if desc.get("requires_approval"):
            lines.append("")
            lines.append("These actions require your approval:")
            for item in desc["requires_approval"]:
                lines.append(f"  - {item}")

        lines.append("")
        lines.append("Try asking:")
        for prompt in desc["common_prompts"][:3]:
            lines.append(f'  "{prompt}"')

        return {"ok": True, "message": "\n".join(lines)}
