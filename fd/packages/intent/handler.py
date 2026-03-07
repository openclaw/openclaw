"""Prompt-first handler — the main entry point for natural language interaction.

This is the unified handler that ties the intent pipeline together:
  prompt → classify → plan → (approval?) → execute → respond

All interfaces (Telegram, Command Center, Notion) call this handler
with a raw prompt and get back a human-readable response.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from packages.intent.classifier import classify_intent
from packages.intent.models import (
    ActionPlan,
    Brand,
    ClassifiedIntent,
    Confidence,
    IntentCategory,
    RiskLevel,
)
from packages.intent.planner import build_plan
from packages.intent.responder import (
    format_approval_request,
    format_clarification,
    format_completion,
    format_error,
    format_plan_preview,
)

logger = logging.getLogger(__name__)


@dataclass
class PromptResult:
    """Result of processing a natural language prompt."""

    response: str  # Human-readable response text
    intent: ClassifiedIntent  # Classified intent
    plan: Optional[ActionPlan] = None  # Execution plan (if applicable)
    needs_clarification: bool = False  # True if we need more info
    needs_approval: bool = False  # True if approval is pending
    approval_step: Optional[str] = None  # Description of step needing approval
    target_agent: str = ""  # Which agent should handle this
    executed: bool = False  # True if the plan was fully executed
    metadata: dict[str, Any] = field(default_factory=dict)


def handle_prompt(
    prompt: str,
    channel_brand: Optional[Brand] = None,
    channel_id: Optional[str] = None,
    user_id: Optional[str] = None,
    dry_run: bool = True,
) -> PromptResult:
    """Process a natural language prompt through the full intent pipeline.

    This is the main entry point for all prompt-first interactions.

    Args:
        prompt: Raw natural language prompt from the user.
        channel_brand: Brand context from channel binding (if known).
        channel_id: Channel identifier for context tracking.
        user_id: User identifier for audit trail.
        dry_run: If True, plan but don't execute (safe by default).

    Returns:
        PromptResult with response text and execution metadata.
    """
    # Step 1: Classify intent
    intent = classify_intent(prompt, channel_brand=channel_brand)

    logger.info(
        "intent_classified",
        extra={
            "category": intent.category.value,
            "confidence": intent.confidence.value,
            "brand": intent.brand.value,
            "domain": intent.domain,
            "action": intent.action_hint,
        },
    )

    # Step 2: Handle low confidence — ask for clarification
    if intent.needs_clarification:
        return PromptResult(
            response=format_clarification(
                "I'm not sure what you'd like me to do. Could you be more specific?",
                options=[
                    "Check system health",
                    "Run a grant scan",
                    "Generate ad content",
                    "Show today's priorities",
                ],
            ),
            intent=intent,
            needs_clarification=True,
        )

    # Step 3: Handle brand disambiguation
    if intent.needs_brand_disambiguation:
        return PromptResult(
            response=format_clarification(
                "Which brand is this for?",
                options=["Full Digital", "CUTMV"],
            ),
            intent=intent,
            needs_clarification=True,
        )

    # Step 4: Build execution plan
    plan = build_plan(intent)

    logger.info(
        "plan_built",
        extra={
            "steps": plan.step_count,
            "risk": plan.risk_level.value,
            "requires_approval": plan.requires_approval,
            "target_agent": plan.target_agent,
        },
    )

    # Step 5: If plan requires approval, show preview and pause
    if plan.requires_approval:
        # Find the first step requiring approval
        approval_step = next(
            (s for s in plan.steps if s.requires_approval), None
        )
        preview = format_plan_preview(plan)

        if approval_step:
            preview += "\n\n" + format_approval_request(plan, approval_step)

        return PromptResult(
            response=preview,
            intent=intent,
            plan=plan,
            needs_approval=True,
            approval_step=approval_step.description if approval_step else None,
            target_agent=plan.target_agent,
        )

    # Step 6: For safe plans in dry_run, show preview
    if dry_run and plan.risk_level != RiskLevel.SAFE:
        preview = format_plan_preview(plan)
        preview += "\n\n(Dry run mode — no changes will be made. Set DRY_RUN=false to execute.)"
        return PromptResult(
            response=preview,
            intent=intent,
            plan=plan,
            target_agent=plan.target_agent,
        )

    # Step 7: For safe plans or when not in dry_run, show completion
    # In a real system, this is where we'd execute the plan steps.
    # For now, return the plan preview as the response.
    if plan.risk_level == RiskLevel.SAFE:
        response = format_completion(plan)
    else:
        response = format_plan_preview(plan)

    return PromptResult(
        response=response,
        intent=intent,
        plan=plan,
        target_agent=plan.target_agent,
        executed=plan.risk_level == RiskLevel.SAFE,
    )
