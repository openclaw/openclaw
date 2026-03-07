"""Walkthrough engine — first-run onboarding and section tours.

When OpenClaw starts for the first time, this engine walks the user
through the system screen by screen, in plain English.
"""

from __future__ import annotations

WALKTHROUGH_STEPS: list[dict] = [
    # --- Screen 1: Welcome ---
    {
        "step": 1,
        "title": "Welcome to OpenClaw",
        "body": (
            "This is your operating system for Full Digital and CUTMV. "
            "You can talk to it in plain English to get things done — "
            "no commands to memorize, no manuals to read."
        ),
        "tip": "Try typing: 'What should I focus on today?'",
        "section": None,
    },
    # --- Screen 2: Command Center ---
    {
        "step": 2,
        "title": "Command Center",
        "body": (
            "This is your main dashboard. It shows today's priorities, "
            "your schedule, system health, and what needs action. "
            "Everything starts here."
        ),
        "tip": "The Today panel shows what matters right now.",
        "section": "command_center",
    },
    # --- Screen 3: Finance ---
    {
        "step": 3,
        "title": "Finance",
        "body": (
            "Finance tracks cash, invoices, expenses, and forecasts. "
            "It also includes GrantOps — your grant discovery and "
            "drafting engine."
        ),
        "tip": "Ask: 'Show me the finance summary.'",
        "section": "finance",
    },
    # --- Screen 4: Marketing ---
    {
        "step": 4,
        "title": "Marketing",
        "body": (
            "Marketing helps you generate ads, evaluate campaign performance, "
            "and prepare safe scaling actions. It will never spend money "
            "without your approval."
        ),
        "tip": "Ask: 'Generate 3 CUTMV ad concepts.'",
        "section": "marketing",
    },
    # --- Screen 5: WebOps ---
    {
        "step": 5,
        "title": "WebOps",
        "body": (
            "WebOps monitors your websites, deployments, tracking pixels, "
            "and webhooks. When something breaks, it generates a repair "
            "plan for your review."
        ),
        "tip": "Ask: 'Check website health.'",
        "section": "webops",
    },
    # --- Screen 6: GrantOps ---
    {
        "step": 6,
        "title": "GrantOps",
        "body": (
            "GrantOps finds grant opportunities, scores them by fit, "
            "and drafts applications. You review and approve before "
            "anything is submitted."
        ),
        "tip": "Ask: 'Find grants for Full Digital.'",
        "section": "grantops",
    },
    # --- Screen 7: Cluster ---
    {
        "step": 7,
        "title": "Your Cluster",
        "body": (
            "OpenClaw runs on your own hardware — M1 Mac Studio for AI, "
            "M4 for the gateway. Shared storage keeps everything in sync. "
            "You can check health anytime."
        ),
        "tip": "Ask: 'Are all nodes online?'",
        "section": "cluster",
    },
    # --- Screen 8: Telegram ---
    {
        "step": 8,
        "title": "Telegram Control",
        "body": (
            "Telegram is your mobile control layer. You get alerts, "
            "approve actions, and run prompts — all from your phone. "
            "Same capabilities as the Command Center."
        ),
        "tip": "Send /help in the OpenClaw Telegram bot.",
        "section": "telegram",
    },
    # --- Screen 9: Approvals ---
    {
        "step": 9,
        "title": "Approvals",
        "body": (
            "Sensitive actions — launching campaigns, increasing budgets, "
            "infrastructure changes — always require your approval. "
            "OpenClaw never spends money or makes risky changes on its own."
        ),
        "tip": "Approvals appear in Telegram and the Command Center.",
        "section": None,
    },
    # --- Screen 10: Simple Mode ---
    {
        "step": 10,
        "title": "Simple Mode",
        "body": (
            "If the full dashboard feels like too much, Simple Mode "
            "strips it down to just priorities, schedule, and a prompt bar. "
            "Everything is still accessible — just cleaner."
        ),
        "tip": "Toggle Simple Mode from the top-right menu.",
        "section": "command_center",
    },
    # --- Screen 11: You're ready ---
    {
        "step": 11,
        "title": "You're Ready",
        "body": (
            "That's the tour. You can always ask OpenClaw: "
            "'What can I do here?' or 'How do I do this?' "
            "and it will guide you step by step."
        ),
        "tip": "Start with: 'Run the start of day routine.'",
        "section": None,
    },
]


class WalkthroughEngine:
    """Serves the first-run walkthrough, step by step."""

    def get_walkthrough(self) -> list[dict]:
        """Return all walkthrough steps."""
        return WALKTHROUGH_STEPS

    def get_step(self, index: int) -> dict | None:
        """Return a single step by zero-based index."""
        if 0 <= index < len(WALKTHROUGH_STEPS):
            return WALKTHROUGH_STEPS[index]
        return None

    def total_steps(self) -> int:
        """Total number of walkthrough steps."""
        return len(WALKTHROUGH_STEPS)

    def get_steps_for_section(self, section_key: str) -> list[dict]:
        """Return walkthrough steps related to a specific section."""
        return [s for s in WALKTHROUGH_STEPS if s.get("section") == section_key]
