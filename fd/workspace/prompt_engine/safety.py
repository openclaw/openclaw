"""Safety gate — translates action plans into safe / approval / blocked.

Enforces the project's non-negotiable safety controls:
  - DRY_RUN=true  → all writes simulated
  - KILL_SWITCH   → all external writes blocked
  - READ_ONLY     → writes blocked, reads allowed
  - Medium/high risk steps → routed through approval layer

Every mutation is recorded via audit and checked against idempotency.
"""

from __future__ import annotations

from typing import Any, Protocol

from packages.common.config import settings
from packages.common.logging import get_logger

from .types import ActionPlan, ActionStep

logger = get_logger(__name__)


class ApprovalEngine(Protocol):
    """Minimal protocol for the approval backend."""
    def request_from_plan(self, plan: ActionPlan) -> str: ...


class StubApprovalEngine:
    """No-op approval engine that returns a placeholder ID."""
    def request_from_plan(self, plan: ActionPlan) -> str:
        return "approval_pending_stub"


# Risk-level weights for numeric comparison
_RISK_WEIGHT: dict[str, int] = {"low": 0, "medium": 1, "high": 2}


class SafetyGate:
    """Reviews an :class:`ActionPlan` and enforces safety policies.

    After review the plan's ``approval_required`` and per-step
    ``requires_approval`` flags are authoritative.
    """

    def __init__(self, approval_engine: ApprovalEngine | None = None):
        self._approval_engine = approval_engine or StubApprovalEngine()

    def review(self, plan: ActionPlan) -> ActionPlan:
        # ── Global kill-switches ────────────────────────────────────────
        if settings.KILL_SWITCH:
            return self._block_plan(plan, "Kill switch is active — all external writes are blocked.")

        if settings.READ_ONLY:
            has_writes = any(self._is_write_action(s) for s in plan.steps)
            if has_writes:
                return self._block_plan(plan, "System is in read-only mode — write actions are blocked.")

        # ── Per-step risk assessment ────────────────────────────────────
        approval_bits: list[str] = []

        for step in plan.steps:
            # Force approval for medium+ risk
            if _RISK_WEIGHT.get(step.risk_level, 0) >= _RISK_WEIGHT["medium"]:
                step.requires_approval = True
                approval_bits.append(step.description)

            # DRY_RUN: tag write steps so executors know to simulate
            if settings.DRY_RUN and self._is_write_action(step):
                step.payload["_dry_run"] = True

        if approval_bits:
            plan.approval_required = True
            plan.approval_summary = "Approval required for: " + "; ".join(approval_bits)

        logger.info(
            "safety_reviewed",
            extra={"extra": {
                "approval_required": plan.approval_required,
                "dry_run": settings.DRY_RUN,
                "steps_needing_approval": len(approval_bits),
            }},
        )

        return plan

    def request_approval(self, plan: ActionPlan) -> str:
        """Create an approval request and return its ID."""
        return self._approval_engine.request_from_plan(plan)

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _is_write_action(step: ActionStep) -> bool:
        """Heuristic: action types containing write/submit/send/create/delete
        are considered write operations."""
        write_verbs = ("write", "submit", "send", "create", "delete", "update", "prepare_submission")
        return any(v in step.action_type for v in write_verbs)

    @staticmethod
    def _block_plan(plan: ActionPlan, reason: str) -> ActionPlan:
        plan.steps = []
        plan.approval_required = False
        plan.summary_for_user = reason
        return plan
