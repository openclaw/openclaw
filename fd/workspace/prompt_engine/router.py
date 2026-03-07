"""Intent router — maps an intent to a named workflow and target agent.

The router is deliberately simple: a lookup table.  Adding a new workflow
means adding one entry here and one planner branch — nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import Intent


@dataclass(frozen=True)
class RouteResult:
    workflow: str
    agent: str | None = None


# Agent binding: (workflow, brand) → agent id
_AGENT_MAP: dict[tuple[str, str | None], str] = {
    ("grantops", "fulldigital"): "fulldigital-finance",
    ("grantops", None): "fulldigital-finance",
    ("marketing_ops", "fulldigital"): "fulldigital-content",
    ("marketing_ops", "cutmv"): "cutmv-growth",
    ("marketing_ops", None): "fulldigital-content",
    ("content_generation", "fulldigital"): "fulldigital-content",
    ("content_generation", "cutmv"): "cutmv-growth",
    ("content_generation", None): "fulldigital-content",
    ("sales_ops", "fulldigital"): "fulldigital-sales",
    ("sales_ops", None): "fulldigital-sales",
    ("system_health", None): "fulldigital-ops",
    ("system_health", "fulldigital"): "fulldigital-ops",
    ("system_health", "cutmv"): "cutmv-ops",
    ("daily_guidance", None): "fulldigital-ops",
    ("daily_guidance", "fulldigital"): "fulldigital-ops",
    ("daily_guidance", "cutmv"): "cutmv-ops",
    ("approvals", None): "fulldigital-ops",
    ("approvals", "fulldigital"): "fulldigital-ops",
    ("approvals", "cutmv"): "cutmv-ops",
}


class PromptRouter:
    """Maps an :class:`Intent` to a workflow name and agent binding."""

    def __init__(self, agent_map: dict[tuple[str, str | None], str] | None = None):
        self._agent_map = agent_map or _AGENT_MAP

    def route(self, intent: Intent) -> RouteResult:
        workflow = self._resolve_workflow(intent)
        agent = (
            self._agent_map.get((workflow, intent.brand))
            or self._agent_map.get((workflow, None))
        )
        return RouteResult(workflow=workflow, agent=agent)

    @staticmethod
    def _resolve_workflow(intent: Intent) -> str:
        if intent.intent_type == "approval_decision":
            return "approvals"

        if intent.workflow:
            return intent.workflow

        # Fallback from intent_type
        return {
            "status_check": "system_health",
            "question": "daily_guidance",
            "generate_content": "content_generation",
            "run_workflow": "fallback",
            "analysis": "daily_guidance",
            "configuration": "fallback",
            "conversation": "fallback",
        }.get(intent.intent_type, "fallback")
