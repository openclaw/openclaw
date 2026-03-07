"""Tests for the prompt-first intent layer.

Tests cover:
  - Intent classification (keyword patterns, brand detection, confidence)
  - Action planning (step generation, risk levels, agent routing)
  - Response formatting (plain English, approval cards, error messages)
  - Full pipeline (prompt → classify → plan → respond)
"""

import pytest

from packages.intent.models import (
    ActionPlan,
    ActionStep,
    Brand,
    ClassifiedIntent,
    Confidence,
    IntentCategory,
    RiskLevel,
)
from packages.intent.classifier import classify_intent
from packages.intent.planner import build_plan
from packages.intent.responder import (
    format_approval_request,
    format_clarification,
    format_completion,
    format_error,
    format_plan_preview,
)
from packages.intent.handler import handle_prompt, PromptResult


# ═══════════════════════════════════════════════
# Intent Classification
# ═══════════════════════════════════════════════


class TestIntentClassification:
    """Test the intent classifier."""

    def test_grant_discovery(self):
        result = classify_intent("Find new grants for Full Digital")
        assert result.category == IntentCategory.WORKFLOW_EXECUTE
        assert result.domain == "grantops"
        assert result.action_hint == "discovery"
        assert result.brand == Brand.FULLDIGITAL
        assert result.confidence == Confidence.HIGH

    def test_grant_scan(self):
        result = classify_intent("Run the daily grant scan")
        assert result.category == IntentCategory.WORKFLOW_EXECUTE
        assert result.domain == "grantops"
        assert result.action_hint == "daily_scan"

    def test_grant_submit(self):
        result = classify_intent("Submit the top three grants")
        assert result.category == IntentCategory.WORKFLOW_EXECUTE
        assert result.domain == "grantops"
        assert result.action_hint == "submit"

    def test_cluster_health(self):
        result = classify_intent("Check the health of the cluster")
        assert result.category == IntentCategory.SYSTEM_HEALTH
        assert result.domain == "cluster"
        assert result.action_hint == "health_check"

    def test_cluster_status(self):
        result = classify_intent("Is the cluster running?")
        assert result.category in (IntentCategory.SYSTEM_HEALTH, IntentCategory.INFORMATION)

    def test_generate_ads(self):
        result = classify_intent("Generate three ad hooks for CUTMV")
        assert result.category == IntentCategory.CONTENT_GENERATE
        assert result.domain == "marketing"
        assert result.brand == Brand.CUTMV
        assert result.entities.get("count") == 3

    def test_generate_captions(self):
        result = classify_intent("Write five captions for Full Digital")
        assert result.category == IntentCategory.CONTENT_GENERATE
        assert result.brand == Brand.FULLDIGITAL
        assert result.entities.get("count") == 5

    def test_campaign_launch(self):
        result = classify_intent("Launch a new campaign for CUTMV")
        assert result.category == IntentCategory.WORKFLOW_EXECUTE
        assert result.domain == "marketing"
        assert result.action_hint == "campaign"
        assert result.brand == Brand.CUTMV

    def test_pipeline_check(self):
        result = classify_intent("Show me the sales pipeline")
        assert result.category == IntentCategory.INFORMATION
        assert result.domain == "sales"

    def test_analysis_query(self):
        result = classify_intent("Why did yesterday's ads underperform?")
        assert result.category == IntentCategory.ANALYSIS

    def test_approval_approve(self):
        result = classify_intent("Approve")
        assert result.category == IntentCategory.APPROVAL_DECISION
        assert result.action_hint == "approve"

    def test_approval_reject(self):
        result = classify_intent("Reject this")
        assert result.category == IntentCategory.APPROVAL_DECISION
        assert result.action_hint == "reject"

    def test_configuration(self):
        result = classify_intent("Enable GrantOps setting")
        assert result.category == IntentCategory.CONFIGURATION

    def test_brand_detection_fulldigital(self):
        result = classify_intent("Something for Full Digital")
        assert result.brand == Brand.FULLDIGITAL

    def test_brand_detection_cutmv(self):
        result = classify_intent("Something for CUTMV")
        assert result.brand == Brand.CUTMV

    def test_brand_detection_fd_shorthand(self):
        result = classify_intent("Check FD pipeline")
        assert result.brand == Brand.FULLDIGITAL

    def test_brand_from_channel(self):
        result = classify_intent(
            "Show today's tasks",
            channel_brand=Brand.CUTMV,
        )
        assert result.brand == Brand.CUTMV

    def test_empty_prompt(self):
        result = classify_intent("")
        assert result.category == IntentCategory.CONVERSATION
        assert result.confidence == Confidence.LOW

    def test_question_mark_upgrades_to_information(self):
        result = classify_intent("What's happening today?")
        assert result.category == IntentCategory.INFORMATION

    def test_ambiguous_brand_lowers_confidence(self):
        result = classify_intent("Generate ad scripts")
        assert result.category == IntentCategory.CONTENT_GENERATE
        # Brand is unknown for a brand-specific action
        assert result.brand == Brand.UNKNOWN
        assert result.confidence == Confidence.MEDIUM

    def test_needs_clarification(self):
        result = classify_intent("do the thing")
        assert result.needs_clarification is True

    def test_needs_brand_disambiguation(self):
        result = classify_intent("Launch a campaign")
        assert result.needs_brand_disambiguation is True


# ═══════════════════════════════════════════════
# Action Planning
# ═══════════════════════════════════════════════


class TestActionPlanning:
    """Test the action planner."""

    def test_grant_scan_plan(self):
        intent = classify_intent("Run the daily grant scan")
        plan = build_plan(intent)
        assert plan.target_agent == "fulldigital-finance"
        assert plan.step_count >= 3
        assert "grant" in plan.human_summary.lower()

    def test_grant_submit_requires_approval(self):
        intent = classify_intent("Submit the grant application for Full Digital")
        plan = build_plan(intent)
        assert plan.requires_approval is True
        assert plan.risk_level == RiskLevel.HIGH

    def test_cluster_health_is_safe(self):
        intent = classify_intent("Check cluster health")
        plan = build_plan(intent)
        assert plan.risk_level == RiskLevel.SAFE
        assert plan.requires_approval is False
        assert plan.step_count >= 3

    def test_content_generation_plan(self):
        intent = classify_intent("Generate 5 ad hooks for CUTMV")
        plan = build_plan(intent)
        assert plan.target_agent == "cutmv-growth"
        assert plan.step_count >= 1

    def test_campaign_requires_approval(self):
        intent = classify_intent("Launch a campaign for Full Digital")
        plan = build_plan(intent)
        assert plan.requires_approval is True
        assert plan.target_agent == "fulldigital-content"

    def test_agent_routing_fd_finance(self):
        intent = classify_intent("Find grants for Full Digital")
        plan = build_plan(intent)
        assert plan.target_agent == "fulldigital-finance"

    def test_agent_routing_cutmv_growth(self):
        intent = classify_intent("Create promo content for CUTMV")
        plan = build_plan(intent)
        assert plan.target_agent == "cutmv-growth"

    def test_agent_routing_fd_sales(self):
        intent = classify_intent("Check the pipeline for Full Digital")
        plan = build_plan(intent)
        assert plan.target_agent == "fulldigital-sales"

    def test_plan_risk_escalation(self):
        """Plan risk should match the highest step risk."""
        intent = classify_intent("Submit grant applications for Full Digital")
        plan = build_plan(intent)
        high_risk_steps = [s for s in plan.steps if s.risk_level == RiskLevel.HIGH]
        assert len(high_risk_steps) > 0
        assert plan.risk_level == RiskLevel.HIGH

    def test_approval_plan(self):
        intent = classify_intent("Approve")
        plan = build_plan(intent)
        assert "approval" in plan.human_summary.lower()

    def test_information_plan(self):
        intent = classify_intent("What grants are available?")
        plan = build_plan(intent)
        assert plan.step_count >= 1
        assert plan.risk_level == RiskLevel.SAFE


# ═══════════════════════════════════════════════
# Response Formatting
# ═══════════════════════════════════════════════


class TestResponseFormatting:
    """Test plain-English response formatting."""

    def test_plan_preview_basic(self):
        intent = classify_intent("Check cluster health")
        plan = build_plan(intent)
        preview = format_plan_preview(plan)
        assert "cluster" in preview.lower() or "health" in preview.lower()

    def test_plan_preview_shows_steps(self):
        intent = classify_intent("Run the daily grant scan")
        plan = build_plan(intent)
        preview = format_plan_preview(plan)
        assert "1." in preview  # Steps are numbered

    def test_plan_preview_mentions_approval(self):
        intent = classify_intent("Submit grant for Full Digital")
        plan = build_plan(intent)
        preview = format_plan_preview(plan)
        assert "approval" in preview.lower()

    def test_approval_request_format(self):
        plan = ActionPlan(
            intent=ClassifiedIntent(
                category=IntentCategory.WORKFLOW_EXECUTE,
                confidence=Confidence.HIGH,
                brand=Brand.FULLDIGITAL,
                raw_prompt="Submit grant",
            ),
        )
        step = ActionStep(
            description="Submit via Submittable API",
            system_call="grantops.submitter.initiate_submission",
            risk_level=RiskLevel.HIGH,
            requires_approval=True,
        )
        msg = format_approval_request(plan, step)
        assert "Approval needed" in msg
        assert "Submittable" in msg
        assert "approve" in msg.lower()
        assert "Fulldigital" in msg

    def test_completion_message_grants(self):
        intent = classify_intent("Run the daily grant scan")
        plan = build_plan(intent)
        msg = format_completion(plan)
        assert "grant" in msg.lower() or "scan" in msg.lower()

    def test_completion_suggests_next_steps(self):
        intent = classify_intent("Run the daily grant scan")
        plan = build_plan(intent)
        msg = format_completion(plan)
        assert "Would you like" in msg

    def test_error_format_no_jargon(self):
        intent = classify_intent("Run the daily grant scan")
        plan = build_plan(intent)
        msg = format_error(plan, "ConnectionError: timeout after 30s")
        assert "timeout" not in msg.lower() or "took too long" in msg.lower()
        assert "ConnectionError" not in msg
        assert "try again" in msg.lower()

    def test_error_format_permission(self):
        intent = classify_intent("Submit grant")
        plan = build_plan(intent)
        msg = format_error(plan, "PermissionError: forbidden")
        assert "permission" in msg.lower()

    def test_clarification_format(self):
        msg = format_clarification(
            "Which brand is this for?",
            options=["Full Digital", "CUTMV"],
        )
        assert "Full Digital" in msg
        assert "CUTMV" in msg


# ═══════════════════════════════════════════════
# Full Pipeline
# ═══════════════════════════════════════════════


class TestFullPipeline:
    """Test the complete prompt → response pipeline."""

    def test_safe_prompt_executes(self):
        result = handle_prompt("Check cluster health")
        assert isinstance(result, PromptResult)
        assert result.intent.category == IntentCategory.SYSTEM_HEALTH
        assert result.plan is not None
        assert result.target_agent == "fulldigital-ops"
        assert result.executed is True

    def test_risky_prompt_shows_preview(self):
        result = handle_prompt("Submit grant for Full Digital", dry_run=True)
        assert result.needs_approval is True
        assert "approval" in result.response.lower()

    def test_ambiguous_prompt_asks_clarification(self):
        result = handle_prompt("do something")
        assert result.needs_clarification is True

    def test_brand_disambiguation(self):
        result = handle_prompt("Launch a campaign")
        assert result.needs_clarification is True
        assert "brand" in result.response.lower() or "CUTMV" in result.response

    def test_channel_brand_context(self):
        result = handle_prompt(
            "Generate ad hooks",
            channel_brand=Brand.CUTMV,
        )
        assert result.intent.brand == Brand.CUTMV
        # With brand known, should not need clarification for brand
        assert result.needs_clarification is False

    def test_dry_run_blocks_moderate_risk(self):
        result = handle_prompt("Run the grant scan for Full Digital", dry_run=True)
        assert "dry run" in result.response.lower() or result.plan is not None

    def test_grant_scan_with_brand(self):
        result = handle_prompt("Find grants for Full Digital")
        assert result.intent.domain == "grantops"
        assert result.intent.brand == Brand.FULLDIGITAL
        assert result.target_agent == "fulldigital-finance"

    def test_content_with_count(self):
        result = handle_prompt(
            "Write 5 ad scripts for CUTMV",
            channel_brand=Brand.CUTMV,
        )
        assert result.intent.entities.get("count") == 5
        assert result.target_agent == "cutmv-growth"

    def test_approval_decision(self):
        result = handle_prompt("Approve")
        assert result.intent.category == IntentCategory.APPROVAL_DECISION

    def test_question_routes_to_information(self):
        result = handle_prompt("What should we focus on today?")
        assert result.intent.category == IntentCategory.INFORMATION
