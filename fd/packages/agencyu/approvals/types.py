"""Approval request types — standardized payload contract for all executors.

Every executor (Meta Ads, WebOps, Webflow, Stripe) must provide:
- estimated_spend_impact_usd
- why_now
- rollback_plan

If missing, safe defaults are populated and a warning is logged.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.approvals.types")

_DEFAULT_WHY_NOW = "Policy triggered; action prepared for review"
_DEFAULT_ROLLBACK = "Rollback: revert to previous state (pause/reduce/undo) and recheck"


@dataclass
class ApprovalRequest:
    """Standardized approval request payload."""

    action_type: str
    brand: str
    risk_level: str
    estimated_spend_impact_usd: float
    why_now: str
    rollback_plan: str
    payload: dict[str, Any]
    correlation_id: str
    compound_action_key: str | None = None

    # Populated after request_approval()
    approval_id: str = ""
    expires_at: str = ""
    requires_two_step: bool = False
    confirm_expires_at: str | None = None

    # Extra metadata injected by executors
    meta: dict[str, Any] = field(default_factory=dict)

    def ensure_defaults(self) -> list[str]:
        """Fill safe defaults for missing required fields. Returns list of warnings."""
        warnings: list[str] = []

        if not self.why_now:
            self.why_now = _DEFAULT_WHY_NOW
            warnings.append("why_now was empty; using safe default")

        if not self.rollback_plan:
            self.rollback_plan = _DEFAULT_ROLLBACK
            warnings.append("rollback_plan was empty; using safe default")

        if self.estimated_spend_impact_usd is None:
            self.estimated_spend_impact_usd = 0.0
            warnings.append("estimated_spend_impact_usd was None; defaulting to 0")

        for w in warnings:
            log.warning("approval_request_default_applied", extra={
                "action_type": self.action_type,
                "correlation_id": self.correlation_id,
                "warning": w,
            })

        return warnings

    def to_engine_kwargs(self) -> dict[str, Any]:
        """Convert to kwargs for ApprovalEngine.request_approval()."""
        summary_parts = [self.why_now]
        if self.estimated_spend_impact_usd:
            summary_parts.append(f"Spend impact: ${abs(self.estimated_spend_impact_usd):,.0f}")

        payload = dict(self.payload)
        payload["risk_level"] = self.risk_level
        payload["estimated_spend_impact_usd"] = self.estimated_spend_impact_usd
        payload["why_now"] = self.why_now
        payload["rollback_plan"] = self.rollback_plan
        if self.compound_action_key:
            payload["compound_action_key"] = self.compound_action_key

        return {
            "action_type": self.action_type,
            "brand": self.brand,
            "payload": payload,
            "summary": " | ".join(summary_parts),
            "correlation_id": self.correlation_id,
            "risk_level": self.risk_level,
        }
