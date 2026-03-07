"""Action planner — builds execution plans from classified intents.

The planner maps intents to system capabilities and constructs step-by-step
execution plans. Each step includes a human-readable description and the
internal system call it maps to.

Pipeline: prompt → classify → **plan** → execute → respond
"""

from __future__ import annotations

from packages.intent.models import (
    ActionPlan,
    Brand,
    ClassifiedIntent,
    IntentCategory,
    RiskLevel,
)

# ── Agent Routing ──
# Maps (domain, brand) to target agent.

_AGENT_MAP: dict[tuple[str, str], str] = {
    # Full Digital
    ("grantops", "fulldigital"): "fulldigital-finance",
    ("marketing", "fulldigital"): "fulldigital-content",
    ("sales", "fulldigital"): "fulldigital-sales",
    ("cluster", "fulldigital"): "fulldigital-ops",
    ("", "fulldigital"): "fulldigital-ops",
    # CUTMV
    ("marketing", "cutmv"): "cutmv-growth",
    ("sales", "cutmv"): "cutmv-growth",
    ("support", "cutmv"): "cutmv-support",
    ("cluster", "cutmv"): "cutmv-ops",
    ("", "cutmv"): "cutmv-ops",
    # Brand-agnostic
    ("cluster", "unknown"): "fulldigital-ops",
    ("grantops", "unknown"): "fulldigital-finance",
}


def _resolve_agent(intent: ClassifiedIntent) -> str:
    """Determine which agent should handle this intent."""
    key = (intent.domain, intent.brand.value)
    if key in _AGENT_MAP:
        return _AGENT_MAP[key]
    # Fall back to domain-only lookup
    fallback_key = (intent.domain, "unknown")
    if fallback_key in _AGENT_MAP:
        return _AGENT_MAP[fallback_key]
    # Default: ops agent for the brand
    brand_default = ("", intent.brand.value)
    return _AGENT_MAP.get(brand_default, "fulldigital-ops")


def build_plan(intent: ClassifiedIntent) -> ActionPlan:
    """Build an execution plan from a classified intent.

    Returns an ActionPlan with steps, risk level, target agent,
    and a human-readable summary.
    """
    agent = _resolve_agent(intent)
    plan = ActionPlan(intent=intent, target_agent=agent)

    # Route to domain-specific planner
    if intent.domain == "grantops":
        _plan_grantops(plan, intent)
    elif intent.domain == "marketing":
        _plan_marketing(plan, intent)
    elif intent.domain == "sales":
        _plan_sales(plan, intent)
    elif intent.domain == "cluster":
        _plan_cluster(plan, intent)
    elif intent.category == IntentCategory.APPROVAL_DECISION:
        _plan_approval(plan, intent)
    elif intent.category == IntentCategory.INFORMATION:
        _plan_information(plan, intent)
    elif intent.category == IntentCategory.ANALYSIS:
        _plan_analysis(plan, intent)
    elif intent.category == IntentCategory.CONFIGURATION:
        _plan_configuration(plan, intent)
    else:
        _plan_conversation(plan, intent)

    return plan


def _plan_grantops(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan GrantOps workflows."""
    action = intent.action_hint

    if action in ("discovery", "daily_scan"):
        plan.human_summary = "Scanning grant databases for relevant opportunities."
        plan.add_step(
            "Query grant APIs (Candid, Grants.gov)",
            "grantops.scanner.run_daily_scan",
            seconds=30,
        )
        plan.add_step(
            "Filter and score opportunities by fit and effort",
            "grantops.scoring.score_batch",
            seconds=5,
        )
        plan.add_step(
            "Write results to database and Notion",
            "grantops.store.upsert_opportunities",
            risk=RiskLevel.MODERATE,
            seconds=10,
        )
        plan.add_step(
            "Send summary to Telegram",
            "grantops.digest.format_daily_digest",
            seconds=2,
        )

    elif action == "draft_package":
        plan.human_summary = "Preparing draft application packages for top grant opportunities."
        plan.add_step(
            "Identify top-scoring opportunities",
            "grantops.store.list_action_needed",
            seconds=2,
        )
        plan.add_step(
            "Extract requirements from opportunity data",
            "grantops.drafter.extract_requirements",
            seconds=5,
        )
        plan.add_step(
            "Generate narrative, budget, and timeline",
            "grantops.drafter.create_draft_package",
            risk=RiskLevel.MODERATE,
            seconds=15,
        )
        plan.add_step(
            "Send package for review via Telegram",
            "grantops.digest.format_package_approval_request",
            seconds=2,
        )

    elif action == "submit":
        plan.human_summary = "Submitting approved grant applications."
        plan.add_step(
            "Verify draft packages are approved",
            "grantops.submitter.check_approved",
            seconds=2,
        )
        plan.add_step(
            "Submit via Submittable API or guided process",
            "grantops.submitter.initiate_submission",
            risk=RiskLevel.HIGH,
            approval=True,
            seconds=30,
        )
        plan.add_step(
            "Record submission and set follow-up date",
            "grantops.store.update_submission",
            risk=RiskLevel.MODERATE,
            seconds=5,
        )


def _plan_marketing(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan marketing/content workflows."""
    action = intent.action_hint
    count = intent.entities.get("count", 3)
    brand = intent.brand.value if intent.brand != Brand.UNKNOWN else "the brand"

    if action == "generate_content":
        plan.human_summary = f"Generating {count} creative concepts for {brand}."
        plan.add_step(
            f"Generate {count} ad hooks and scripts",
            "creative.generate_hooks",
            seconds=15,
        )
        plan.add_step(
            "Format results for review",
            "creative.format_results",
            seconds=2,
        )

    elif action == "campaign":
        plan.human_summary = f"Setting up a new marketing campaign for {brand}."
        plan.add_step(
            "Generate creative angles based on current strategy",
            "creative.generate_angles",
            seconds=10,
        )
        plan.add_step(
            "Produce ad scripts and copy",
            "creative.generate_scripts",
            seconds=15,
        )
        plan.add_step(
            "Queue render jobs for creative assets",
            "jobs.queue.submit",
            risk=RiskLevel.MODERATE,
            seconds=5,
        )
        plan.add_step(
            "Prepare campaign for launch (requires approval)",
            "marketing.prepare_campaign",
            risk=RiskLevel.HIGH,
            approval=True,
            seconds=10,
        )

    elif action == "content_calendar":
        plan.human_summary = f"Planning content calendar for {brand}."
        plan.add_step(
            "Analyze recent content performance",
            "analytics.content_performance",
            seconds=10,
        )
        plan.add_step(
            "Generate weekly content plan",
            "content.plan_week",
            seconds=15,
        )
        plan.add_step(
            "Write plan to Notion",
            "notion.update_content_calendar",
            risk=RiskLevel.MODERATE,
            seconds=5,
        )


def _plan_sales(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan sales workflows."""
    action = intent.action_hint

    if action == "pipeline_status":
        plan.human_summary = "Pulling current pipeline status."
        plan.add_step(
            "Query GHL pipeline data",
            "integrations.ghl.get_pipeline",
            seconds=5,
        )
        plan.add_step(
            "Summarize pipeline health",
            "sales.summarize_pipeline",
            seconds=3,
        )

    elif action == "outreach":
        plan.human_summary = "Preparing outreach materials."
        plan.add_step(
            "Draft outreach message",
            "sales.draft_outreach",
            seconds=10,
        )
        plan.add_step(
            "Send for review (requires approval)",
            "sales.review_outreach",
            risk=RiskLevel.HIGH,
            approval=True,
            seconds=2,
        )


def _plan_cluster(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan cluster/system operations."""
    action = intent.action_hint

    if action in ("health_check", "ollama_status"):
        plan.human_summary = "Checking cluster health across all nodes."
        plan.add_step(
            "Check SSH connectivity to M4 and i7",
            "cluster.check_ssh",
            seconds=5,
        )
        plan.add_step(
            "Verify services are running (tmux sessions)",
            "cluster.check_services",
            seconds=5,
        )
        plan.add_step(
            "Check Ollama status on M1 and M4",
            "cluster.check_ollama",
            seconds=3,
        )
        plan.add_step(
            "Report disk usage and pending jobs",
            "cluster.check_storage",
            seconds=3,
        )


def _plan_approval(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan approval/rejection actions."""
    action = intent.action_hint
    if action == "approve":
        plan.human_summary = "Processing your approval."
        plan.add_step(
            "Confirm and execute the pending action",
            "approvals.confirm",
            risk=RiskLevel.MODERATE,
            seconds=5,
        )
    else:
        plan.human_summary = "Rejecting the pending action."
        plan.add_step(
            "Cancel the pending action",
            "approvals.reject",
            seconds=2,
        )


def _plan_information(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan information retrieval."""
    plan.human_summary = "Looking that up for you."
    plan.add_step(
        "Query relevant data sources",
        "information.query",
        seconds=5,
    )
    plan.add_step(
        "Format response",
        "information.format",
        seconds=2,
    )


def _plan_analysis(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan analysis tasks."""
    plan.human_summary = "Analyzing the data to answer your question."
    plan.add_step(
        "Gather relevant metrics and data",
        "analysis.gather",
        seconds=10,
    )
    plan.add_step(
        "Run analysis and generate insights",
        "analysis.run",
        seconds=15,
    )
    plan.add_step(
        "Format findings",
        "analysis.format",
        seconds=3,
    )


def _plan_configuration(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Plan configuration changes."""
    plan.human_summary = "Reviewing the requested configuration change."
    plan.add_step(
        "Validate the requested change",
        "config.validate",
        seconds=2,
    )
    plan.add_step(
        "Apply configuration (requires approval)",
        "config.apply",
        risk=RiskLevel.HIGH,
        approval=True,
        seconds=5,
    )


def _plan_conversation(plan: ActionPlan, intent: ClassifiedIntent) -> None:
    """Handle general conversation."""
    plan.human_summary = "Responding to your message."
    plan.add_step(
        "Generate conversational response",
        "conversation.respond",
        seconds=3,
    )
