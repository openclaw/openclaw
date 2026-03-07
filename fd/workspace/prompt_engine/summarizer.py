"""Post-execution summariser — explains what happened in plain English.

Every action should be explainable in one sentence:
  "I did X because you asked for Y and the safest workflow is Z."

The summariser can also produce plan-preview cards and natural-language
approval requests for the approval layer.
"""

from __future__ import annotations

from .types import ActionPlan, ExecutionResult, Intent


class Summarizer:
    """Generates human-readable summaries of plans and results."""

    def plan_preview(self, plan: ActionPlan) -> str:
        """Render a plan as a human-readable preview card."""
        lines = [f"Here's what I'll do ({plan.step_count} step(s)):"]
        for i, step in enumerate(plan.steps, 1):
            risk_tag = ""
            if step.risk_level != "low":
                risk_tag = f" [{step.risk_level} risk]"
            approval_tag = " (needs approval)" if step.requires_approval else ""
            lines.append(f"  {i}. {step.description}{risk_tag}{approval_tag}")

        if plan.approval_required:
            lines.append("")
            lines.append("Some steps need your approval before I proceed.")

        dry_steps = [s for s in plan.steps if s.payload.get("_dry_run")]
        if dry_steps:
            lines.append("")
            lines.append("(Dry-run mode is on — no real changes will be made.)")

        return "\n".join(lines)

    def approval_request(self, plan: ActionPlan) -> str:
        """Format a natural-language approval request."""
        steps_needing = [s for s in plan.steps if s.requires_approval]
        if not steps_needing:
            return "No steps require approval."

        lines = ["I need your approval to continue:"]
        for step in steps_needing:
            lines.append(f"  - {step.description} [{step.risk_level} risk]")
        lines.append("")
        lines.append("Reply 'approve' to proceed, or 'deny' to cancel.")
        return "\n".join(lines)

    def execution_summary(self, intent: Intent, plan: ActionPlan, result: ExecutionResult) -> str:
        """One-sentence explanation of what happened and why."""
        if result.approval_requested:
            return (
                f"I prepared a plan to {plan.goal.lower().rstrip('.')} "
                f"and sent it for approval."
            )

        if not result.ok:
            warning_text = "; ".join(result.warnings) if result.warnings else "unknown error"
            return f"I tried to {plan.goal.lower().rstrip('.')} but ran into issues: {warning_text}"

        return (
            f"Done. I {plan.goal[0].lower()}{plan.goal[1:].rstrip('.')} "
            f"because you asked '{intent.raw_prompt[:80]}'"
            f"{' and the safest workflow is ' + (intent.workflow or 'default') if intent.workflow else ''}."
        )

    def daily_digest(self, results: list[tuple[ActionPlan, ExecutionResult]]) -> str:
        """Summarise multiple results into a daily digest."""
        if not results:
            return "Nothing to report today."

        lines = ["Here's what happened today:"]
        for plan, result in results:
            status = "done" if result.ok else "issue"
            lines.append(f"  - [{status}] {plan.goal}")

        ok_count = sum(1 for _, r in results if r.ok)
        lines.append(f"\n{ok_count}/{len(results)} actions completed successfully.")
        return "\n".join(lines)
