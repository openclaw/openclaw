"""Explain engine — answers "what happens if I do this?"

Takes an action description and returns a plain-English explanation
of what OpenClaw will do, what's automated, and what needs approval.
"""

from __future__ import annotations

from .capabilities import CAPABILITIES

# Maps keywords to explanations of what happens.
_EXPLANATIONS: dict[str, dict] = {
    "start the day": {
        "action": "Start the Day routine",
        "what_happens": (
            "OpenClaw syncs all widgets, pulls fresh data from your integrations, "
            "and refreshes the Today panel with updated priorities, schedule, "
            "and health status."
        ),
        "automated": True,
        "needs_approval": False,
    },
    "scale ads": {
        "action": "Scale ad campaigns",
        "what_happens": (
            "OpenClaw analyzes campaign performance, identifies winners, "
            "and prepares a scaling plan with projected spend impact. "
            "You review the plan before anything changes."
        ),
        "automated": False,
        "needs_approval": True,
    },
    "generate ads": {
        "action": "Generate ad concepts",
        "what_happens": (
            "OpenClaw uses AI to draft ad hooks, angles, and copy variations. "
            "You pick the ones you like. Nothing is published automatically."
        ),
        "automated": True,
        "needs_approval": False,
    },
    "run grant scan": {
        "action": "Run a grant scan",
        "what_happens": (
            "OpenClaw searches grant databases, scores opportunities by fit, "
            "and presents the top matches. You choose which ones to draft."
        ),
        "automated": True,
        "needs_approval": False,
    },
    "submit grant": {
        "action": "Submit a grant application",
        "what_happens": (
            "OpenClaw packages the draft and prepares it for submission. "
            "You must review and explicitly approve before it's sent."
        ),
        "automated": False,
        "needs_approval": True,
    },
    "deploy": {
        "action": "Deploy changes",
        "what_happens": (
            "OpenClaw runs pre-deployment checks, validates the change, "
            "and stages it for your approval. Nothing goes live until you say so."
        ),
        "automated": False,
        "needs_approval": True,
    },
    "health check": {
        "action": "Run a health check",
        "what_happens": (
            "OpenClaw inspects all nodes, services, and shared storage, "
            "then shows you a status report. This is read-only."
        ),
        "automated": True,
        "needs_approval": False,
    },
    "failover": {
        "action": "Trigger failover",
        "what_happens": (
            "OpenClaw checks if M1 is down, then switches AI inference to M4. "
            "This keeps your system running but on backup hardware."
        ),
        "automated": False,
        "needs_approval": True,
    },
}


def explain_action(action: str) -> dict:
    """Explain what happens when *action* is performed."""
    text = action.lower().strip()

    for key, explanation in _EXPLANATIONS.items():
        if key in text:
            return {"ok": True, **explanation}

    # Try matching against capability actions
    for section in CAPABILITIES.values():
        for cap_action in section["can_do"]:
            if text in cap_action.lower() or cap_action.lower() in text:
                return {
                    "ok": True,
                    "action": cap_action,
                    "what_happens": (
                        f"This action is part of {section['name']}. "
                        f"{section['description']}"
                    ),
                    "automated": True,
                    "needs_approval": cap_action in section.get("requires_approval", []),
                }

    return {
        "ok": True,
        "action": action,
        "what_happens": (
            "I'm not sure exactly what that does yet, but I can help you "
            "figure it out. Try describing what you want to accomplish."
        ),
        "automated": False,
        "needs_approval": False,
    }
