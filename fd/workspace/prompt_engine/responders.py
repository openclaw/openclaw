"""Response builder — turns execution results into human-readable replies.

Every response should sound like a helpful operator, not a dev console.
The builder merges intent context with execution outputs to produce
a clear, plain-English summary.
"""

from __future__ import annotations

from .types import (
    ActionPlan,
    ContextPacket,
    EngineResponse,
    ExecutionResult,
    Intent,
)


class ResponseBuilder:
    """Converts engine internals into user-facing replies."""

    def build(
        self,
        intent: Intent,
        context: ContextPacket,
        plan: ActionPlan,
        result: ExecutionResult,
        conversation_id: str | None = None,
    ) -> EngineResponse:
        reply = self._format_reply(intent, plan, result)

        return EngineResponse(
            ok=result.ok,
            reply=reply,
            intent=intent,
            plan=plan,
            result=result,
            conversation_id=conversation_id,
        )

    def build_clarification(
        self,
        intent: Intent,
        conversation_id: str | None = None,
    ) -> EngineResponse:
        question = intent.clarification_question or "Can you clarify what you'd like me to do?"
        return EngineResponse(
            ok=True,
            reply=question,
            intent=intent,
            conversation_id=conversation_id,
        )

    def build_error(
        self,
        message: str,
        intent: Intent | None = None,
        conversation_id: str | None = None,
    ) -> EngineResponse:
        return EngineResponse(
            ok=False,
            reply=f"Something went wrong: {message}",
            intent=intent,
            conversation_id=conversation_id,
        )

    # ── internal formatting ─────────────────────────────────────────────

    def _format_reply(
        self, intent: Intent, plan: ActionPlan, result: ExecutionResult
    ) -> str:
        parts: list[str] = []

        # Approval pending
        if result.approval_requested:
            parts.append(plan.summary_for_user)
            if plan.approval_summary:
                parts.append(plan.approval_summary)
            parts.append(
                f"Reply 'approve' or 'deny' to continue. (Ref: {result.approval_id})"
            )
            return "\n\n".join(parts)

        # Empty plan (clarification / fallback)
        if plan.step_count == 0:
            return plan.summary_for_user

        # Success
        parts.append(result.summary)

        # Attach warnings
        if result.warnings:
            parts.append("Heads up:")
            for w in result.warnings:
                parts.append(f"  - {w}")

        # Dry-run notice
        dry_steps = [s for s in plan.steps if s.payload.get("_dry_run")]
        if dry_steps:
            parts.append("(Dry-run mode — no real changes were made.)")

        return "\n\n".join(parts)
