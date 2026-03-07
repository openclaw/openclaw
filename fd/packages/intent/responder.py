"""Plain-English response formatter.

Translates system actions and results into human-readable language.
This is the final step in the prompt-first pipeline:
  prompt → classify → plan → execute → **respond**

All responses follow these rules:
  - No technical jargon in user-facing messages
  - Lead with the answer or outcome
  - Include next steps when appropriate
  - Use conversational tone, not command output
"""

from __future__ import annotations

from packages.intent.models import ActionPlan, ActionStep, RiskLevel


def format_plan_preview(plan: ActionPlan) -> str:
    """Format an action plan as a human-readable preview.

    Shown to the user before execution, especially for high-risk plans.
    """
    lines = [plan.human_summary, ""]

    if plan.step_count > 1:
        lines.append("Here's what I'll do:")
        for i, step in enumerate(plan.steps, 1):
            marker = "→" if not step.requires_approval else "⏸"
            lines.append(f"  {i}. {marker} {step.description}")

    if plan.requires_approval:
        lines.append("")
        lines.append("This includes actions that require your approval.")
        lines.append("I'll pause and ask before proceeding with those steps.")

    return "\n".join(lines)


def format_step_start(step: ActionStep, step_num: int, total: int) -> str:
    """Format a message when starting a step."""
    return f"Step {step_num}/{total}: {step.description}..."


def format_step_complete(step: ActionStep, step_num: int, total: int) -> str:
    """Format a message when a step completes."""
    return f"Done ({step_num}/{total}): {step.description}"


def format_approval_request(plan: ActionPlan, step: ActionStep) -> str:
    """Format a Telegram approval card for a high-risk step."""
    lines = [
        f"**Approval needed**",
        "",
        f"**Action:** {step.description}",
        f"**Risk level:** {_risk_label(step.risk_level)}",
    ]

    if plan.intent.brand.value != "unknown":
        lines.append(f"**Brand:** {plan.intent.brand.value.title()}")

    lines.extend([
        "",
        "Reply **approve** to proceed or **reject** to cancel.",
    ])

    return "\n".join(lines)


def format_completion(plan: ActionPlan, results: dict | None = None) -> str:
    """Format the final completion message after all steps finish."""
    lines = []

    if results and "summary" in results:
        lines.append(results["summary"])
    else:
        lines.append(_completion_message(plan))

    # Suggest next steps
    next_steps = _suggest_next_steps(plan)
    if next_steps:
        lines.append("")
        lines.append("Would you like me to:")
        for suggestion in next_steps:
            lines.append(f"  • {suggestion}")

    return "\n".join(lines)


def format_error(plan: ActionPlan, error: str) -> str:
    """Format an error message in human-readable language."""
    # Never expose raw stack traces or system errors
    return (
        f"I ran into an issue while {_gerund(plan.human_summary)}.\n"
        f"\n"
        f"What happened: {_humanize_error(error)}\n"
        f"\n"
        f"Would you like me to try again or take a different approach?"
    )


def format_clarification(question: str, options: list[str] | None = None) -> str:
    """Format a clarification question."""
    lines = [question]
    if options:
        lines.append("")
        for opt in options:
            lines.append(f"  • {opt}")
    return "\n".join(lines)


# ── Helpers ──


def _risk_label(risk: RiskLevel) -> str:
    return {
        RiskLevel.SAFE: "Low (read-only)",
        RiskLevel.MODERATE: "Medium (internal writes)",
        RiskLevel.HIGH: "High (external action)",
    }[risk]


def _gerund(summary: str) -> str:
    """Convert a summary to gerund form for error messages."""
    s = summary.lower().rstrip(".")
    if s.startswith("scanning"):
        return s
    if s.startswith("check"):
        return "checking" + s[5:]
    if s.startswith("prepar"):
        return "preparing" + s[7:]
    # Generic fallback
    return f"working on this: {s}"


def _humanize_error(error: str) -> str:
    """Convert technical errors to human language."""
    e = error.lower()
    if "timeout" in e or "timed out" in e:
        return "The operation took too long to complete."
    if "connection" in e or "unreachable" in e:
        return "I couldn't connect to one of the required services."
    if "permission" in e or "forbidden" in e:
        return "I don't have the right permissions for this action."
    if "not found" in e:
        return "I couldn't find the resource I was looking for."
    if "rate limit" in e:
        return "We've hit a rate limit. I'll try again shortly."
    # Don't expose raw error — keep it generic
    return "Something unexpected went wrong."


def _completion_message(plan: ActionPlan) -> str:
    """Generate a completion message based on the plan domain."""
    domain = plan.intent.domain
    action = plan.intent.action_hint

    if domain == "grantops" and action in ("discovery", "daily_scan"):
        return "Grant scan complete. Results are in your Notion dashboard."
    if domain == "grantops" and action == "draft_package":
        return "Draft packages are ready for your review."
    if domain == "grantops" and action == "submit":
        return "Grant submissions have been processed."
    if domain == "marketing" and action == "generate_content":
        return "Your creative concepts are ready."
    if domain == "marketing" and action == "campaign":
        return "Campaign is prepared and awaiting your launch approval."
    if domain == "cluster":
        return "Cluster health check complete."
    if domain == "sales":
        return "Here's your pipeline update."

    return "All done."


def _suggest_next_steps(plan: ActionPlan) -> list[str]:
    """Suggest follow-up actions based on what just completed."""
    domain = plan.intent.domain
    action = plan.intent.action_hint
    suggestions: list[str] = []

    if domain == "grantops":
        if action in ("discovery", "daily_scan"):
            suggestions.append("Prepare draft applications for the top opportunities")
            suggestions.append("Show me the highest-scoring grants")
        elif action == "draft_package":
            suggestions.append("Submit the approved drafts")
            suggestions.append("Review the packages in Notion")
    elif domain == "marketing":
        if action == "generate_content":
            suggestions.append("Refine these concepts")
            suggestions.append("Start a full campaign with these hooks")
        elif action == "campaign":
            suggestions.append("Review the campaign before launch")
    elif domain == "cluster":
        suggestions.append("Start services on any stopped nodes")
        suggestions.append("Run the failover check")

    return suggestions[:3]
