"""Capacity Engine — utilization forecasting + overload prevention + hiring triggers.

Extends the base capacity module (sync/capacity.py) with:
  - calculate_utilization(): per-role and total utilization metrics
  - predict_overload_risk(): forecast when team hits capacity wall
  - check_hiring_triggers(): recommend hires before breaking
  - should_block_scaling(): prevent ad scaling if team can't fulfill

AgencyU principle: Scale = hire before breaking.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.agencyu.sync.capacity import get_capacity_overview
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.capacity_engine")


# ── Data models ──


@dataclass(frozen=True)
class RoleUtilization:
    """Utilization metrics for a single role."""

    role: str
    members: int
    total_capacity: int
    current_load: int
    utilization_pct: float  # 0-100
    available_slots: int
    at_risk: bool  # utilization > 80%


@dataclass(frozen=True)
class OverloadForecast:
    """Predicted overload timeline."""

    role: str
    current_utilization_pct: float
    weekly_intake_rate: float  # New work items per week
    weekly_completion_rate: float  # Completed items per week
    weeks_to_capacity: float  # Weeks until 100% utilization
    risk_level: str  # low | medium | high | critical


@dataclass(frozen=True)
class HiringRecommendation:
    """Recommendation to hire for a specific role."""

    role: str
    reason: str
    urgency: str  # low | medium | high | critical
    current_utilization_pct: float
    recommended_hires: int
    weeks_to_overload: float


@dataclass
class CapacityReport:
    """Full capacity intelligence report."""

    overview: dict[str, Any] = field(default_factory=dict)
    by_role: list[RoleUtilization] = field(default_factory=list)
    forecasts: list[OverloadForecast] = field(default_factory=list)
    hiring: list[HiringRecommendation] = field(default_factory=list)
    scaling_blocked: bool = False
    scaling_block_reason: str = ""
    generated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "overview": self.overview,
            "by_role": [
                {
                    "role": r.role,
                    "members": r.members,
                    "total_capacity": r.total_capacity,
                    "current_load": r.current_load,
                    "utilization_pct": r.utilization_pct,
                    "available_slots": r.available_slots,
                    "at_risk": r.at_risk,
                }
                for r in self.by_role
            ],
            "forecasts": [
                {
                    "role": f.role,
                    "utilization_pct": f.current_utilization_pct,
                    "intake_rate": f.weekly_intake_rate,
                    "completion_rate": f.weekly_completion_rate,
                    "weeks_to_capacity": f.weeks_to_capacity,
                    "risk": f.risk_level,
                }
                for f in self.forecasts
            ],
            "hiring": [
                {
                    "role": h.role,
                    "reason": h.reason,
                    "urgency": h.urgency,
                    "utilization_pct": h.current_utilization_pct,
                    "recommended_hires": h.recommended_hires,
                    "weeks_to_overload": h.weeks_to_overload,
                }
                for h in self.hiring
            ],
            "scaling_blocked": self.scaling_blocked,
            "scaling_block_reason": self.scaling_block_reason,
            "generated_at": self.generated_at,
        }


# ── Thresholds ──

UTILIZATION_WARNING_PCT = 75.0
UTILIZATION_CRITICAL_PCT = 90.0
SCALING_BLOCK_THRESHOLD_PCT = 85.0
HIRING_TRIGGER_WEEKS = 4  # Hire if overload predicted within N weeks


def calculate_utilization(
    conn: sqlite3.Connection,
) -> list[RoleUtilization]:
    """Calculate utilization per role from team_capacity_v2."""
    try:
        rows = conn.execute(
            """SELECT
                COALESCE(role, 'general') AS role,
                COUNT(*) AS members,
                SUM(max_concurrent_work) AS total_cap,
                SUM(current_open_work) AS total_load
            FROM team_capacity_v2
            WHERE enabled = 1
            GROUP BY role"""
        ).fetchall()
    except Exception:
        log.debug("utilization_query_error", exc_info=True)
        return []

    result: list[RoleUtilization] = []
    for r in rows:
        cap = int(r["total_cap"] or 1)
        load = int(r["total_load"] or 0)
        util = round((load / max(1, cap)) * 100, 1)

        result.append(RoleUtilization(
            role=r["role"],
            members=int(r["members"]),
            total_capacity=cap,
            current_load=load,
            utilization_pct=util,
            available_slots=max(0, cap - load),
            at_risk=util >= UTILIZATION_WARNING_PCT,
        ))

    return sorted(result, key=lambda r: r.utilization_pct, reverse=True)


def predict_overload_risk(
    conn: sqlite3.Connection,
    *,
    lookback_weeks: int = 4,
) -> list[OverloadForecast]:
    """Forecast overload risk per role.

    Estimates intake rate (new work items per week) and completion rate
    from work_orders + team_capacity history, then projects when
    each role will hit 100% utilization.
    """
    utilizations = calculate_utilization(conn)
    since = (datetime.now(UTC) - timedelta(weeks=lookback_weeks)).isoformat()
    forecasts: list[OverloadForecast] = []

    for role_util in utilizations:
        role = role_util.role

        # Estimate weekly intake from work_orders created
        try:
            intake_row = conn.execute(
                """SELECT COUNT(*) AS cnt FROM work_orders
                   WHERE created_at >= ?
                   AND assigned_role = ?""",
                (since, role),
            ).fetchone()
            total_intake = int(intake_row["cnt"] or 0)
        except Exception:
            # Fallback: estimate from all work orders
            try:
                intake_row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM work_orders WHERE created_at >= ?",
                    (since,),
                ).fetchone()
                total_intake = int(intake_row["cnt"] or 0) // max(1, len(utilizations))
            except Exception:
                total_intake = 0

        weekly_intake = total_intake / max(1, lookback_weeks)

        # Estimate completion rate from work_orders completed
        try:
            complete_row = conn.execute(
                """SELECT COUNT(*) AS cnt FROM work_orders
                   WHERE updated_at >= ?
                   AND status IN ('completed', 'delivered')""",
                (since,),
            ).fetchone()
            total_completed = int(complete_row["cnt"] or 0)
        except Exception:
            total_completed = 0

        weekly_completion = total_completed / max(1, lookback_weeks)

        # Net growth rate
        net_weekly = weekly_intake - weekly_completion
        available = role_util.available_slots

        if net_weekly <= 0:
            weeks_to_cap = 999.0  # Not approaching capacity
            risk = "low"
        elif available <= 0:
            weeks_to_cap = 0.0
            risk = "critical"
        else:
            weeks_to_cap = round(available / net_weekly, 1)
            if weeks_to_cap <= 2:
                risk = "critical"
            elif weeks_to_cap <= HIRING_TRIGGER_WEEKS:
                risk = "high"
            elif weeks_to_cap <= 8:
                risk = "medium"
            else:
                risk = "low"

        forecasts.append(OverloadForecast(
            role=role,
            current_utilization_pct=role_util.utilization_pct,
            weekly_intake_rate=round(weekly_intake, 1),
            weekly_completion_rate=round(weekly_completion, 1),
            weeks_to_capacity=weeks_to_cap,
            risk_level=risk,
        ))

    return sorted(forecasts, key=lambda f: f.weeks_to_capacity)


def check_hiring_triggers(
    conn: sqlite3.Connection,
) -> list[HiringRecommendation]:
    """Check if hiring triggers are met for any role.

    Triggers:
    - Utilization > 85% → hire 1
    - Overload predicted within 4 weeks → hire 1-2
    - Utilization > 95% → urgent hire 2
    """
    forecasts = predict_overload_risk(conn)
    utilizations = {u.role: u for u in calculate_utilization(conn)}
    recommendations: list[HiringRecommendation] = []

    for forecast in forecasts:
        role = forecast.role
        util = utilizations.get(role)
        if not util:
            continue

        if util.utilization_pct >= 95:
            recommendations.append(HiringRecommendation(
                role=role,
                reason=f"Critical: {util.utilization_pct:.0f}% utilized, team at breaking point",
                urgency="critical",
                current_utilization_pct=util.utilization_pct,
                recommended_hires=2,
                weeks_to_overload=forecast.weeks_to_capacity,
            ))
        elif forecast.weeks_to_capacity <= HIRING_TRIGGER_WEEKS:
            hires = 2 if forecast.weeks_to_capacity <= 2 else 1
            recommendations.append(HiringRecommendation(
                role=role,
                reason=f"Overload in {forecast.weeks_to_capacity:.0f} weeks at current intake rate",
                urgency="high" if forecast.weeks_to_capacity <= 2 else "medium",
                current_utilization_pct=util.utilization_pct,
                recommended_hires=hires,
                weeks_to_overload=forecast.weeks_to_capacity,
            ))
        elif util.utilization_pct >= UTILIZATION_WARNING_PCT:
            recommendations.append(HiringRecommendation(
                role=role,
                reason=f"Approaching capacity: {util.utilization_pct:.0f}% utilized",
                urgency="low",
                current_utilization_pct=util.utilization_pct,
                recommended_hires=1,
                weeks_to_overload=forecast.weeks_to_capacity,
            ))

    return sorted(recommendations, key=lambda h: h.weeks_to_overload)


def should_block_scaling(
    conn: sqlite3.Connection,
) -> dict[str, Any]:
    """Check if ad scaling should be blocked due to capacity constraints.

    Blocks scaling if any role is above SCALING_BLOCK_THRESHOLD_PCT
    or if overload is predicted within 2 weeks.
    """
    utilizations = calculate_utilization(conn)
    forecasts = predict_overload_risk(conn)

    blocked = False
    reasons: list[str] = []

    for u in utilizations:
        if u.utilization_pct >= SCALING_BLOCK_THRESHOLD_PCT:
            blocked = True
            reasons.append(f"{u.role}: {u.utilization_pct:.0f}% utilized (threshold: {SCALING_BLOCK_THRESHOLD_PCT}%)")

    for f in forecasts:
        if f.weeks_to_capacity <= 2 and f.risk_level in ("critical", "high"):
            blocked = True
            reasons.append(f"{f.role}: overload in {f.weeks_to_capacity:.0f} weeks")

    return {
        "blocked": blocked,
        "reasons": reasons,
        "threshold_pct": SCALING_BLOCK_THRESHOLD_PCT,
    }


def run_capacity_report(
    conn: sqlite3.Connection,
) -> CapacityReport:
    """Generate the full capacity intelligence report.

    Combines utilization, forecasting, hiring recommendations,
    and scaling block checks.
    """
    overview = get_capacity_overview(conn)
    by_role = calculate_utilization(conn)
    forecasts = predict_overload_risk(conn)
    hiring = check_hiring_triggers(conn)
    scaling = should_block_scaling(conn)

    report = CapacityReport(
        overview=overview,
        by_role=by_role,
        forecasts=forecasts,
        hiring=hiring,
        scaling_blocked=scaling["blocked"],
        scaling_block_reason="; ".join(scaling.get("reasons", [])),
        generated_at=datetime.now(UTC).isoformat(),
    )

    log.info("capacity_report_generated", extra={
        "utilization": overview.get("utilization", 0),
        "at_risk_roles": sum(1 for r in by_role if r.at_risk),
        "hiring_recommendations": len(hiring),
        "scaling_blocked": scaling["blocked"],
    })

    return report
