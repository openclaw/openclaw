"""UI adapter — bridges the Command Center frontend to the engine.

The adapter accepts HTTP-style requests from the web UI and returns
structured responses that the frontend can render as cards, previews,
or approval dialogs.
"""

from __future__ import annotations

from workspace.prompt_engine.engine import OpenClawPromptEngine
from workspace.prompt_engine.types import EngineResponse, UserPrompt


class UIPromptAdapter:
    """Bridges the Command Center UI to the OpenClaw Prompt Engine."""

    def __init__(self, engine: OpenClawPromptEngine):
        self.engine = engine

    def handle_prompt(
        self,
        user_id: str,
        text: str,
        brand_hint: str | None = None,
        conversation_id: str | None = None,
    ) -> EngineResponse:
        prompt = UserPrompt(
            text=text,
            channel="ui",
            user_id=user_id,
            brand_hint=brand_hint,
            conversation_id=conversation_id or f"ui:{user_id}",
        )
        return self.engine.handle(prompt)

    def to_json(self, response: EngineResponse) -> dict:
        """Serialise an engine response for the frontend."""
        data: dict = {
            "ok": response.ok,
            "reply": response.reply,
            "conversation_id": response.conversation_id,
        }

        if response.intent:
            data["intent"] = {
                "type": response.intent.intent_type,
                "confidence": response.intent.confidence,
                "brand": response.intent.brand,
                "workflow": response.intent.workflow,
            }

        if response.plan:
            data["plan"] = {
                "goal": response.plan.goal,
                "steps": response.plan.step_count,
                "approval_required": response.plan.approval_required,
                "target_agent": response.plan.target_agent,
            }

        if response.result:
            data["result"] = {
                "ok": response.result.ok,
                "warnings": response.result.warnings,
                "approval_requested": response.result.approval_requested,
                "approval_id": response.result.approval_id,
            }

        return data
