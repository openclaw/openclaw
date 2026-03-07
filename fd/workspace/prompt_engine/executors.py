"""Plan executor and built-in workflow executors.

The :class:`PlanExecutor` walks through an action plan step by step,
delegating each step to the appropriate executor from the registry.

Built-in executors below provide stub implementations for the core
workflows.  Replace them with real integrations as each subsystem
comes online.
"""

from __future__ import annotations

from typing import Any

from packages.common.ids import new_id
from packages.common.logging import get_logger

from .registry import ExecutorRegistry
from .safety import SafetyGate
from .types import ActionPlan, ExecutionResult

logger = get_logger(__name__)


class PlanExecutor:
    """Walks an action plan and runs each step through the registry."""

    def __init__(self, registry: ExecutorRegistry, safety_gate: SafetyGate):
        self._registry = registry
        self._safety = safety_gate

    def run(self, plan: ActionPlan) -> ExecutionResult:
        correlation_id = new_id("exec")

        # ── Approval gate ───────────────────────────────────────────────
        if plan.approval_required:
            approval_id = self._safety.request_approval(plan)
            logger.info(
                "approval_requested",
                extra={"extra": {
                    "approval_id": approval_id,
                    "correlation_id": correlation_id,
                }},
            )
            return ExecutionResult(
                ok=True,
                summary=plan.approval_summary or "Approval required.",
                approval_requested=True,
                approval_id=approval_id,
                correlation_id=correlation_id,
            )

        # ── Execute steps ───────────────────────────────────────────────
        outputs: dict[str, Any] = {}
        warnings: list[str] = []

        for step in plan.steps:
            if not self._registry.has(step.executor):
                warnings.append(f"Executor '{step.executor}' not registered — skipped '{step.description}'.")
                logger.info(
                    "executor_missing",
                    extra={"extra": {"executor": step.executor, "step": step.step_id}},
                )
                continue

            executor = self._registry.get(step.executor)
            try:
                result = executor.execute(step.action_type, step.payload)
                outputs[step.step_id] = result
            except Exception as exc:
                logger.error(
                    "step_failed",
                    extra={"extra": {
                        "step": step.step_id,
                        "error": str(exc),
                        "correlation_id": correlation_id,
                    }},
                )
                warnings.append(f"Step '{step.description}' failed: {exc}")

        return ExecutionResult(
            ok=len(warnings) == 0,
            summary=plan.summary_for_user,
            outputs=outputs,
            warnings=warnings,
            correlation_id=correlation_id,
        )


# ── Built-in workflow executors ─────────────────────────────────────────────
# Each returns a dict so outputs stay serialisable.


class SystemHealthExecutor:
    """Checks cluster, gateway, and Ollama status."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        # Stub — wire to scripts/healthcheck.sh or the real health endpoint
        return {
            "cluster": "healthy",
            "gateway": "running",
            "ollama": "available",
            "note": "Stub result — wire to real healthcheck.",
        }


class GrantOpsExecutor:
    """Grant scanning, scoring, summarisation, and submission prep."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        dry_run = payload.get("_dry_run", False)
        return {
            "action": action_type,
            "brand": payload.get("brand"),
            "dry_run": dry_run,
            "note": "Stub result — wire to packages/integrations/ grant clients.",
        }


class MarketingOpsExecutor:
    """Campaign analysis and next-action proposals."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "action": action_type,
            "brand": payload.get("brand"),
            "note": "Stub result — wire to marketing analytics.",
        }


class ContentGenerationExecutor:
    """Content creation and review via Remotion / Ollama."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "action": action_type,
            "brand": payload.get("brand"),
            "count": payload.get("count", 1),
            "note": "Stub result — wire to Ollama + Remotion pipeline.",
        }


class DailyGuidanceExecutor:
    """Assembles today's priorities from schedule, finance, and tasks."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "action": action_type,
            "brand": payload.get("brand"),
            "note": "Stub result — wire to schedule + task providers.",
        }


class SalesOpsExecutor:
    """Pipeline status and follow-up suggestions."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "action": action_type,
            "brand": payload.get("brand"),
            "note": "Stub result — wire to GHL pipeline client.",
        }


class ApprovalExecutor:
    """Processes approve/deny decisions."""

    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        decision = payload.get("decision", "approve")
        approval_id = payload.get("approval_id")
        return {
            "action": action_type,
            "decision": decision,
            "approval_id": approval_id,
            "note": f"Stub result — {decision}d.",
        }


def register_default_executors(registry: ExecutorRegistry) -> None:
    """Wire all built-in executors into a registry."""
    registry.register("system_executor", SystemHealthExecutor())
    registry.register("grant_executor", GrantOpsExecutor())
    registry.register("marketing_executor", MarketingOpsExecutor())
    registry.register("content_executor", ContentGenerationExecutor())
    registry.register("daily_executor", DailyGuidanceExecutor())
    registry.register("sales_executor", SalesOpsExecutor())
    registry.register("approval_executor", ApprovalExecutor())
