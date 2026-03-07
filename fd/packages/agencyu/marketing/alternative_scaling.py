"""Alternative Scaling Planner — suggests partial scale now + queue remainder.

When a Meta budget increase is BLOCKED (projected > cap), this module
computes the maximum allowable delta under the cap and suggests:
1. Scale by ``delta_now`` immediately (fits under cap)
2. Queue ``delta_later`` for tomorrow (requires separate approval)

Safe-mode only (v1): generates a plan, does not execute.

Usage::

    planner = AlternativeScalingPlanner()
    plan = planner.plan(
        cap_usd=200, current_total_usd=190, requested_delta_usd=50,
    )
    # plan.delta_now_usd == 10, plan.delta_later_usd == 40
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


@dataclass
class AlternativeScalingPlan:
    """A partial-scale suggestion when full delta is blocked."""

    requested_delta_usd: float
    allowed_delta_now_usd: float
    delta_now_usd: float
    delta_later_usd: float
    next_run_at: str
    summary_lines: list[str]
    confidence: str  # HIGH — math is deterministic


class AlternativeScalingPlanner:
    """Compute a partial-scale plan that fits under the cap.

    Parameters
    ----------
    next_run_hour_utc : int
        Hour (UTC) to schedule the remainder.  Default 14 (~9 AM ET).
    """

    def __init__(self, *, next_run_hour_utc: int = 14) -> None:
        self.next_run_hour_utc = next_run_hour_utc

    def plan(
        self,
        *,
        cap_usd: float,
        current_total_usd: float,
        requested_delta_usd: float,
    ) -> AlternativeScalingPlan:
        allowed_now = max(0.0, cap_usd - current_total_usd)
        delta_now = max(0.0, min(requested_delta_usd, allowed_now))
        delta_later = max(0.0, requested_delta_usd - delta_now)

        now = datetime.now(UTC)
        next_run = (now + timedelta(days=1)).replace(
            hour=self.next_run_hour_utc, minute=0, second=0, microsecond=0,
        )
        next_run_at = next_run.isoformat()

        lines: list[str] = []
        lines.append(f"Requested delta: ${requested_delta_usd:,.0f}/day")
        lines.append(f"Allowed now (under cap): ${allowed_now:,.0f}/day")
        lines.append(f"Suggested now: +${delta_now:,.0f}/day")
        if delta_later > 0:
            lines.append(
                f"Suggested later: +${delta_later:,.0f}/day (queue for tomorrow)"
            )
            lines.append(
                "Note: Later step will require a new approval when it runs."
            )
        else:
            lines.append("No remainder; this fully fits under cap now.")
        lines.append("Note: SAFE-MODE plan (no changes applied).")

        return AlternativeScalingPlan(
            requested_delta_usd=float(requested_delta_usd),
            allowed_delta_now_usd=float(allowed_now),
            delta_now_usd=float(delta_now),
            delta_later_usd=float(delta_later),
            next_run_at=next_run_at,
            summary_lines=lines,
            confidence="HIGH",
        )
