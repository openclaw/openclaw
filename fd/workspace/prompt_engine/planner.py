"""Action planner — converts intent + context into a safe list of steps.

Each workflow gets its own plan-building method.  The planner never
executes anything — it only produces an :class:`ActionPlan` that the
safety gate and executor consume downstream.
"""

from __future__ import annotations

from packages.common.logging import get_logger

from .types import ActionPlan, ActionStep, ContextPacket, Intent, RiskLevel

logger = get_logger(__name__)


class PromptPlanner:
    """Builds structured action plans from classified intents."""

    def build_plan(self, intent: Intent, context: ContextPacket, workflow: str) -> ActionPlan:
        builder = self._WORKFLOW_BUILDERS.get(workflow, self._plan_fallback)
        plan = builder(self, intent, context)
        logger.info(
            "plan_built",
            extra={"extra": {
                "workflow": workflow,
                "steps": plan.step_count,
                "goal": plan.goal,
            }},
        )
        return plan

    # ── workflow-specific builders ──────────────────────────────────────

    def _plan_grantops(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        action_hint = intent.entities.get("action_hint") or "discovery"
        steps = [
            ActionStep(
                step_id="scan",
                description="Scan for new grant opportunities",
                action_type="grant.scan",
                executor="grant_executor",
                payload={"brand": ctx.brand},
            ),
            ActionStep(
                step_id="score",
                description="Score opportunities by fit and effort",
                action_type="grant.score",
                executor="grant_executor",
                payload={"brand": ctx.brand},
            ),
            ActionStep(
                step_id="summarize",
                description="Summarise best matches for review",
                action_type="grant.write_summary",
                executor="grant_executor",
                payload={"brand": ctx.brand, "action_hint": action_hint},
            ),
        ]

        # Submission is high-risk — needs approval
        if action_hint in ("submit", "draft_package"):
            steps.append(
                ActionStep(
                    step_id="submit",
                    description="Prepare grant submission package",
                    action_type="grant.prepare_submission",
                    executor="grant_executor",
                    payload={"brand": ctx.brand},
                    risk_level="high",
                    requires_approval=True,
                ),
            )

        return ActionPlan(
            goal="Find and surface the best grant opportunities.",
            brand=ctx.brand,
            steps=steps,
            summary_for_user="I'll scan for grants, score them, and surface the best matches.",
        )

    def _plan_system_health(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        return ActionPlan(
            goal="Check system health.",
            brand=ctx.brand,
            steps=[
                ActionStep(
                    step_id="health",
                    description="Check cluster, gateway, and Ollama status",
                    action_type="system.health",
                    executor="system_executor",
                    payload={"brand": ctx.brand},
                ),
            ],
            summary_for_user="I'll check the health of the cluster and summarise anything needing attention.",
        )

    def _plan_marketing_ops(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        return ActionPlan(
            goal="Analyse marketing and suggest the best next move.",
            brand=ctx.brand,
            steps=[
                ActionStep(
                    step_id="analyze",
                    description="Review campaign performance and identify risks",
                    action_type="marketing.analyze",
                    executor="marketing_executor",
                    payload={"brand": ctx.brand, "entities": intent.entities},
                ),
                ActionStep(
                    step_id="propose",
                    description="Prepare the safest next action",
                    action_type="marketing.propose_next_actions",
                    executor="marketing_executor",
                    payload={"brand": ctx.brand},
                    risk_level="medium",
                ),
            ],
            summary_for_user="I'll review campaign performance and prepare the safest next step.",
        )

    def _plan_content_generation(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        count = intent.entities.get("count", 3)
        return ActionPlan(
            goal=f"Generate {count} content piece(s).",
            brand=ctx.brand,
            steps=[
                ActionStep(
                    step_id="generate",
                    description=f"Generate {count} content piece(s)",
                    action_type="content.generate",
                    executor="content_executor",
                    payload={
                        "brand": ctx.brand,
                        "count": count,
                        "raw_prompt": intent.raw_prompt,
                    },
                ),
                ActionStep(
                    step_id="review",
                    description="Format and review generated content",
                    action_type="content.review",
                    executor="content_executor",
                    payload={"brand": ctx.brand},
                ),
            ],
            summary_for_user=f"I'll generate {count} piece(s) and format them for your review.",
        )

    def _plan_daily_guidance(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        return ActionPlan(
            goal="Summarise what matters most today.",
            brand=ctx.brand,
            steps=[
                ActionStep(
                    step_id="daily",
                    description="Assemble today's priorities, deadlines, and focus areas",
                    action_type="daily.guidance",
                    executor="daily_executor",
                    payload={"brand": ctx.brand},
                ),
            ],
            summary_for_user="I'll pull together today's priorities, deadlines, and focus areas.",
        )

    def _plan_sales_ops(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        return ActionPlan(
            goal="Review sales pipeline and suggest follow-ups.",
            brand=ctx.brand,
            steps=[
                ActionStep(
                    step_id="pipeline",
                    description="Pull current pipeline status",
                    action_type="sales.pipeline_status",
                    executor="sales_executor",
                    payload={"brand": ctx.brand},
                ),
                ActionStep(
                    step_id="followup",
                    description="Identify overdue follow-ups",
                    action_type="sales.suggest_followups",
                    executor="sales_executor",
                    payload={"brand": ctx.brand},
                ),
            ],
            summary_for_user="I'll check the pipeline and flag any follow-ups that need attention.",
        )

    def _plan_approvals(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        decision = intent.entities.get("decision", "approve")
        approval_id = intent.entities.get("approval_id")
        return ActionPlan(
            goal=f"Process approval decision: {decision}.",
            brand=ctx.brand,
            steps=[
                ActionStep(
                    step_id="decide",
                    description=f"{decision.capitalize()} the pending action",
                    action_type=f"approval.{decision}",
                    executor="approval_executor",
                    payload={
                        "decision": decision,
                        "approval_id": approval_id,
                        "raw_text": intent.entities.get("raw_text", ""),
                    },
                ),
            ],
            summary_for_user=f"I'll {decision} the pending action.",
        )

    def _plan_fallback(self, intent: Intent, ctx: ContextPacket) -> ActionPlan:
        return ActionPlan(
            goal="Clarify request.",
            brand=ctx.brand,
            steps=[],
            summary_for_user="I need a little more detail before I can act.",
        )

    # ── dispatch table ──────────────────────────────────────────────────

    _WORKFLOW_BUILDERS = {
        "grantops": _plan_grantops,
        "marketing_ops": _plan_marketing_ops,
        "system_health": _plan_system_health,
        "content_generation": _plan_content_generation,
        "daily_guidance": _plan_daily_guidance,
        "sales_ops": _plan_sales_ops,
        "approvals": _plan_approvals,
    }
