"""Marketing Brain — Master Orchestrator for the OpenClaw Revenue OS.

Full Digital LLC — CUTMV + Full Digital.
Central intelligence engine connecting all sub-systems:
- Meta Ads Manager (engines/meta_ads.py)
- Revenue Forecast Engine (engines/revenue_forecast.py)
- LTV Retention Engine (engines/ltv_retention.py)
- Setter Performance Tracker (trackers/setter_performance.py)
- ClickFunnels VSL Manager (integrations/clickfunnels_vsl.py)
- Experiment Matrix (marketing/experiment_matrix.py)
- Attribution Ledger (marketing/attribution_ledger.py)
- Playbook Registry (marketing/playbook_registry.py)

Runs a 10-step daily optimization cycle:
1. Collect state from all engines
2. Evaluate ad performance (kill/scale)
3. Score setter performance & alerts
4. Run churn prediction & retention actions
5. Analyze funnel conversion data
6. Run revenue forecast (Monte Carlo)
7. Reallocate budget using LTV:CAC ratios
8. Check phase advancement (Validation → Optimization → Scale)
9. Leverage optimization engines (offer angles, authority, VSL, setters, retainer, profit)
10. Generate executive report

Decision Framework:
- Phase 1 (Week 1-2): $80/day combined, validate assumptions
- Phase 2 (Week 3-6): A/B test variants, optimize for CPA
- Phase 3 (Week 7+): Scale winners, expand audiences
"""
from __future__ import annotations

import os
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
from packages.agencyu.engines.meta_ads import MetaAdsManager
from packages.agencyu.engines.revenue_forecast import RevenueForecastEngine, ForecastResult
from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
from packages.agencyu.marketing.metrics_types import ComboMetrics, ComboMetricsFD  # noqa: F401 (re-export)
from packages.agencyu.marketing.policy_trace import DecisionTrace
from packages.agencyu.marketing.playbook_registry import PlaybookRegistry, seed_default_modules
from packages.agencyu.services.circuit_breaker import CircuitBreaker
from packages.agencyu.services.system_state import SystemState, SystemKeys
from packages.agencyu.trackers.setter_performance import SetterPerformanceTracker, SetterStatus
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.brain")

# Default policy path relative to this file
_DEFAULT_POLICY_PATH = Path(__file__).resolve().parent.parent / "config" / "experiment_policy.yaml"


# ── Enums ──


class Phase(StrEnum):
    VALIDATION = "phase_1_validation"
    OPTIMIZATION = "phase_2_optimize"
    SCALE = "phase_3_scale"


class AlertSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"
    ACTION_REQUIRED = "action_required"


# ── Data Models ──


@dataclass
class BrandState:
    """Current operational state of a brand."""

    brand: str
    phase: Phase = Phase.VALIDATION
    daily_budget: float = 0.0
    total_spend_to_date: float = 0.0
    total_revenue_to_date: float = 0.0
    active_campaigns: int = 0
    active_variants: int = 0
    current_cpa: float = 0.0
    current_roas: float = 0.0
    current_mrr: float = 0.0
    active_customers: int = 0
    avg_ltv: float = 0.0
    max_allowable_cac: float = 0.0

    @property
    def roi(self) -> float:
        if self.total_spend_to_date == 0:
            return 0.0
        return (self.total_revenue_to_date - self.total_spend_to_date) / self.total_spend_to_date * 100


@dataclass
class OptimizationDecision:
    """A single decision made by the brain."""

    timestamp: str
    brand: str
    decision_type: str
    target: str
    action: str
    metrics: dict[str, Any] = field(default_factory=dict)
    executed: bool = False


@dataclass
class DailyReport:
    """Executive daily report output."""

    date: str
    brands: dict[str, dict[str, Any]]
    decisions_made: list[dict[str, Any]]
    alerts: list[dict[str, Any]]
    forecast: dict[str, Any]
    setter_summary: dict[str, Any]
    retention_summary: dict[str, Any]
    funnel_summary: dict[str, Any]


# ── The Brain ──


class MarketingBrain:
    """Central orchestrator for the entire OpenClaw marketing system."""

    def __init__(
        self,
        conn: sqlite3.Connection | None = None,
        variants_config: dict[str, Any] | None = None,
    ) -> None:
        self.conn = conn
        self.ads = MetaAdsManager(variants_config=variants_config)
        self.forecast_engine = RevenueForecastEngine()
        self.ltv = LTVRetentionEngine()
        self.setters = SetterPerformanceTracker()
        self.funnels = ClickFunnelsVSLManager()
        self.playbook = PlaybookRegistry()
        seed_default_modules(self.playbook)

        self.experiment_matrix: ExperimentMatrix | None = None
        if variants_config:
            self.experiment_matrix = ExperimentMatrix(config=variants_config)

        self.ledger: AttributionLedger | None = None
        if conn is not None:
            self.ledger = AttributionLedger(conn)

        self.brands: dict[str, BrandState] = {
            "cutmv": BrandState(brand="cutmv", daily_budget=50.0),
            "fulldigital": BrandState(brand="fulldigital", daily_budget=30.0),
        }
        self.current_phase: dict[str, Phase] = {
            "cutmv": Phase.VALIDATION,
            "fulldigital": Phase.VALIDATION,
        }
        self.decisions: list[OptimizationDecision] = []
        self.alerts: list[dict[str, Any]] = []

        # Phase advancement criteria
        self.phase_criteria = {
            Phase.VALIDATION: {"min_spend": 500, "min_conversions": 10, "min_days": 7},
            Phase.OPTIMIZATION: {"min_spend": 3000, "min_conversions": 50, "min_days": 21, "winning_variants": 2},
        }

    # ── Daily Optimization Cycle ──

    def run_daily_cycle(self) -> DailyReport:
        """Execute the full 9-step daily optimization cycle."""
        log.info("daily_cycle_started")
        self.alerts = []
        cycle_decisions: list[OptimizationDecision] = []

        # Step 1: Refresh state
        self._refresh_brand_states()

        # Step 2: Evaluate ads
        ad_decisions = self._evaluate_ads()
        cycle_decisions.extend(ad_decisions)

        # Step 3: Setter performance
        setter_summary = self._evaluate_setters()

        # Step 4: Retention
        retention_summary = self._evaluate_retention()

        # Step 5: Funnel analytics
        funnel_summary = self._evaluate_funnels()

        # Step 6: Revenue forecast
        forecast_results = self._run_forecasts()

        # Step 7: Budget allocation
        budget_decisions = self._optimize_budget_allocation()
        cycle_decisions.extend(budget_decisions)

        # Step 8: Phase advancement
        phase_decisions = self._check_phase_advancement()
        cycle_decisions.extend(phase_decisions)

        # Step 9: Leverage optimization engines
        leverage_summary = self._run_leverage_engines()

        # Step 10: Compile report
        report = DailyReport(
            date=date.today().isoformat(),
            brands={k: self._brand_state_to_dict(v) for k, v in self.brands.items()},
            decisions_made=[self._decision_to_dict(d) for d in cycle_decisions],
            alerts=self.alerts,
            forecast=forecast_results,
            setter_summary=setter_summary,
            retention_summary=retention_summary,
            funnel_summary=funnel_summary,
        )

        log.info("daily_cycle_complete", extra={
            "decisions": len(cycle_decisions),
            "alerts": len(self.alerts),
        })
        return report

    # ── Step 1: State Collection ──

    def _refresh_brand_states(self) -> None:
        for brand_key, state in self.brands.items():
            ad_report = self.ads.generate_daily_report()
            brand_data = ad_report.get("brands", {}).get(brand_key, {})
            state.active_campaigns = brand_data.get("active_ads", 0)
            state.current_roas = brand_data.get("blended_roas", 0)
            state.current_cpa = brand_data.get("blended_cpa", 0)

            max_cac = self.ltv.calculate_max_cac(brand_key)
            state.max_allowable_cac = max_cac.get("recommended_max_cac", 0)
            state.phase = self.current_phase[brand_key]

    # ── Step 2: Ad Evaluation ──

    def _evaluate_ads(self) -> list[OptimizationDecision]:
        actions = self.ads.run_optimization_cycle()
        decisions: list[OptimizationDecision] = []

        for action_type in ("killed", "scaled"):
            if actions.get(action_type, 0) > 0:
                decisions.append(OptimizationDecision(
                    timestamp=datetime.utcnow().isoformat(),
                    brand="all",
                    decision_type=f"ads_{action_type}",
                    target="optimization_cycle",
                    action=f"{actions[action_type]} ads {action_type}",
                    metrics=actions,
                    executed=True,
                ))

        self.decisions.extend(decisions)
        return decisions

    # ── Step 3: Setter Evaluation ──

    def _evaluate_setters(self) -> dict[str, Any]:
        alerts = self.setters.check_alerts()
        for alert in alerts:
            self.alerts.append({
                "type": f"setter_{alert['type']}",
                "severity": alert["severity"],
                "message": alert["message"],
            })

        leaderboard = self.setters.generate_leaderboard(period_days=7)
        return {
            "total_active_setters": sum(
                1 for s in self.setters.setters.values() if s.status == SetterStatus.ACTIVE
            ),
            "alerts": len(alerts),
            "leaderboard_top_3": leaderboard[:3] if leaderboard else [],
            "avg_score": round(
                sum(s["overall_score"] for s in leaderboard) / len(leaderboard), 1
            ) if leaderboard else 0,
        }

    # ── Step 4: Retention Evaluation ──

    def _evaluate_retention(self) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        for brand_key in ("cutmv", "fulldigital"):
            customers = [
                c for c in self.ltv.customers.values()
                if c.brand == brand_key and c.status == "active"
            ]
            high_risk: list[dict[str, Any]] = []
            for customer in customers:
                risk = self.ltv.predict_churn_risk(customer.id)
                if risk.get("risk_score", 0) >= 70:
                    high_risk.append({
                        "customer_id": customer.id,
                        "risk_score": risk["risk_score"],
                    })

            summary[brand_key] = {
                "active_customers": len(customers),
                "high_risk_count": len(high_risk),
            }

            if len(customers) > 0 and len(high_risk) / len(customers) > 0.20:
                self.alerts.append({
                    "type": "churn_spike",
                    "severity": AlertSeverity.CRITICAL,
                    "brand": brand_key,
                    "message": f"{len(high_risk)}/{len(customers)} customers at high churn risk.",
                })

        return summary

    # ── Step 5: Funnel Evaluation ──

    def _evaluate_funnels(self) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        for funnel_id in self.funnels.funnels:
            analytics = self.funnels.get_funnel_analytics(funnel_id, days=7)
            if analytics.get("no_data"):
                continue
            summary[funnel_id] = analytics

            brand = analytics.get("brand", "")
            if analytics.get("opt_in_rate", 100) < 20:
                self.alerts.append({
                    "type": "low_optin_rate", "severity": AlertSeverity.WARNING,
                    "brand": brand,
                    "message": f"Opt-in rate {analytics['opt_in_rate']}% (target: 30%+)",
                })
            if analytics.get("vsl_completion_rate", 100) < 30:
                self.alerts.append({
                    "type": "low_vsl_completion", "severity": AlertSeverity.WARNING,
                    "brand": brand,
                    "message": f"VSL completion rate {analytics['vsl_completion_rate']}%",
                })
        return summary

    # ── Step 6: Revenue Forecast ──

    def _run_forecasts(self) -> dict[str, Any]:
        results: dict[str, Any] = {}
        for brand_key in ("cutmv", "fulldigital"):
            state = self.brands[brand_key]
            scenarios = self.forecast_engine.run_scenarios(
                brand=brand_key, starting_mrr=state.current_mrr, period_days=90,
            )
            moderate = scenarios.get("moderate")
            if moderate:
                results[brand_key] = {
                    "scenario": moderate.scenario,
                    "total_spend": moderate.total_spend,
                    "total_revenue": moderate.total_revenue,
                    "net_profit": moderate.net_profit,
                    "roi": moderate.roi,
                    "new_customers": moderate.new_customers,
                    "confidence_interval": moderate.confidence_interval,
                }
                if moderate.roi < 0:
                    self.alerts.append({
                        "type": "negative_roi_forecast",
                        "severity": AlertSeverity.CRITICAL,
                        "brand": brand_key,
                        "message": f"90-day forecast shows negative ROI ({moderate.roi}%)",
                    })
        return results

    # ── Step 7: Budget Allocation ──

    def _optimize_budget_allocation(self) -> list[OptimizationDecision]:
        decisions: list[OptimizationDecision] = []
        for brand_key, state in self.brands.items():
            if state.phase == Phase.VALIDATION:
                continue

            if state.phase == Phase.OPTIMIZATION:
                if state.max_allowable_cac > 0 and state.current_cpa > 0:
                    cac_ratio = state.max_allowable_cac / state.current_cpa
                    if cac_ratio > 2.0:
                        new_budget = min(state.daily_budget * 1.15, 300)
                        if new_budget > state.daily_budget:
                            decisions.append(OptimizationDecision(
                                timestamp=datetime.utcnow().isoformat(),
                                brand=brand_key,
                                decision_type="budget_increase",
                                target=brand_key,
                                action=f"Budget ${state.daily_budget:.0f} → ${new_budget:.0f} (CAC ratio: {cac_ratio:.1f}x)",
                                metrics={"old_budget": state.daily_budget, "new_budget": new_budget},
                            ))
                            state.daily_budget = new_budget
                    elif cac_ratio < 1.0:
                        new_budget = max(state.daily_budget * 0.80, 30)
                        decisions.append(OptimizationDecision(
                            timestamp=datetime.utcnow().isoformat(),
                            brand=brand_key,
                            decision_type="budget_decrease",
                            target=brand_key,
                            action=f"Budget ${state.daily_budget:.0f} → ${new_budget:.0f} (CPA exceeds max CAC)",
                            metrics={"old_budget": state.daily_budget, "new_budget": new_budget},
                        ))
                        state.daily_budget = new_budget

            elif state.phase == Phase.SCALE:
                if state.current_roas >= 2.0:
                    new_budget = min(state.daily_budget * 1.20, 500)
                    if new_budget > state.daily_budget:
                        decisions.append(OptimizationDecision(
                            timestamp=datetime.utcnow().isoformat(),
                            brand=brand_key,
                            decision_type="scale_budget",
                            target=brand_key,
                            action=f"Scaling to ${new_budget:.0f}/day (ROAS: {state.current_roas:.1f}x)",
                            metrics={"new_budget": new_budget, "roas": state.current_roas},
                        ))
                        state.daily_budget = new_budget

        self.decisions.extend(decisions)
        return decisions

    # ── Step 8: Phase Advancement ──

    def _check_phase_advancement(self) -> list[OptimizationDecision]:
        decisions: list[OptimizationDecision] = []
        for brand_key, state in self.brands.items():
            current = self.current_phase[brand_key]

            if current == Phase.VALIDATION:
                criteria = self.phase_criteria[Phase.VALIDATION]
                if state.total_spend_to_date >= criteria["min_spend"] and state.active_campaigns > 0:
                    decisions.append(OptimizationDecision(
                        timestamp=datetime.utcnow().isoformat(),
                        brand=brand_key,
                        decision_type="phase_advance",
                        target=brand_key,
                        action=f"Phase 1 → Phase 2 (spend: ${state.total_spend_to_date:,.0f})",
                    ))
                    self.current_phase[brand_key] = Phase.OPTIMIZATION
                    state.phase = Phase.OPTIMIZATION

            elif current == Phase.OPTIMIZATION:
                criteria = self.phase_criteria[Phase.OPTIMIZATION]
                if state.total_spend_to_date >= criteria["min_spend"] and state.current_roas >= 1.5:
                    decisions.append(OptimizationDecision(
                        timestamp=datetime.utcnow().isoformat(),
                        brand=brand_key,
                        decision_type="phase_advance",
                        target=brand_key,
                        action=f"Phase 2 → Phase 3 (ROAS: {state.current_roas:.1f}x)",
                    ))
                    self.current_phase[brand_key] = Phase.SCALE
                    state.phase = Phase.SCALE

        self.decisions.extend(decisions)
        return decisions

    # ── Step 9: Leverage Optimization Engines ──

    def _run_leverage_engines(self) -> dict[str, Any]:
        """Run the 5 optimization engines and collect summaries.

        Each engine is fault-isolated — failure in one does not block others.
        Requires self.conn to be set.
        """
        summary: dict[str, Any] = {}

        if self.conn is None:
            return summary

        # Offer Angle Rotation
        try:
            from packages.agencyu.marketing.offer_angles import run_rotation_cycle

            angle_results: dict[str, Any] = {}
            for brand_key in self.brands:
                angle_results[brand_key] = run_rotation_cycle(
                    self.conn, brand_key, safe_mode=True,
                )
            summary["offer_angles"] = angle_results
        except Exception:
            log.debug("leverage_offer_angles_error", exc_info=True)

        # Authority Scheduler (seed on Mondays)
        try:
            from packages.agencyu.marketing.authority_scheduler import (
                get_weekly_authority_report,
                seed_content_queue,
            )

            auth_results: dict[str, Any] = {}
            for brand_key in self.brands:
                auth_results[brand_key] = get_weekly_authority_report(self.conn, brand_key)
                if datetime.utcnow().weekday() == 0:
                    seed_content_queue(self.conn, brand_key, safe_mode=True)
            summary["authority_scheduler"] = auth_results
        except Exception:
            log.debug("leverage_authority_scheduler_error", exc_info=True)

        # VSL Optimizer
        try:
            from packages.agencyu.marketing.vsl_optimizer import run_vsl_optimization_cycle

            summary["vsl"] = run_vsl_optimization_cycle(self.conn)
        except Exception:
            log.debug("leverage_vsl_error", exc_info=True)

        # Setter Router
        try:
            from packages.agencyu.marketing.setter_router import rank_setters as _rank

            setter_data: dict[str, Any] = {}
            for brand_key in self.brands:
                ranked = _rank(self.conn, brand_key)
                setter_data[brand_key] = {
                    "active": len(ranked),
                    "top_scorer": ranked[0].display_name if ranked else None,
                }
            summary["setter_routing"] = setter_data
        except Exception:
            log.debug("leverage_setter_router_error", exc_info=True)

        # Retainer Funnel
        try:
            from packages.agencyu.marketing.retainer_funnel import run_retainer_scan

            retainer = run_retainer_scan(self.conn, safe_mode=True)
            summary["retainer_funnel"] = {
                "candidates": len(retainer.get("results", [])),
            }
        except Exception:
            log.debug("leverage_retainer_funnel_error", exc_info=True)

        # Profit Engine
        try:
            from packages.agencyu.finance.profit_engine import run_profit_report

            profit = run_profit_report(self.conn)
            summary["profit"] = profit.summary
        except Exception:
            log.debug("leverage_profit_error", exc_info=True)

        log.info("leverage_engines_complete", extra={
            "engines_ok": [k for k in summary if "error" not in str(summary[k])],
        })
        return summary

    # ── Phase 1 Activation Sprint ──

    def launch_phase_1(self) -> dict[str, Any]:
        """Execute Phase 1 Activation Sprint for both brands.

        CUTMV: 3 ads × 1 CTA × 1 offer → $50/day
        Full Digital: 1 ad × 1 CTA × 1 offer → $30/day
        Total: $80/day ($2,400/month)
        """
        results: dict[str, Any] = {}

        cutmv_test = self.ads.launch_phase_1_cutmv()
        cutmv_funnel = self.funnels.create_cutmv_funnel()
        results["cutmv"] = {
            "test_id": cutmv_test["id"],
            "funnel_id": cutmv_funnel["id"],
            "daily_budget": 50,
            "status": "live",
        }
        self.current_phase["cutmv"] = Phase.VALIDATION
        self.brands["cutmv"].phase = Phase.VALIDATION

        fd_test = self.ads.launch_phase_1_fulldigital()
        fd_funnel = self.funnels.create_fulldigital_funnel()
        results["fulldigital"] = {
            "test_id": fd_test["id"],
            "funnel_id": fd_funnel["id"],
            "daily_budget": 30,
            "status": "live",
        }
        self.current_phase["fulldigital"] = Phase.VALIDATION
        self.brands["fulldigital"].phase = Phase.VALIDATION

        log.info("phase_1_launched", extra={"total_budget": 80})
        return results

    # ── Cross-Brand Intelligence ──

    def identify_cross_sell_opportunities(self) -> list[dict[str, Any]]:
        """Find customers who could benefit from the other brand."""
        return self.ltv.identify_expansion_opportunities()

    def get_unified_attribution_report(self, days: int = 30) -> dict[str, Any]:
        """Pull attribution data across all systems for a unified view."""
        report: dict[str, Any] = {"period_days": days, "brands": {}}
        for brand_key in ("cutmv", "fulldigital"):
            visitors = [v for v in self.funnels.visitors.values() if v.brand == brand_key]
            creative_perf: dict[str, dict[str, Any]] = {}
            for v in visitors:
                key = v.creative_variant or "organic"
                if key not in creative_perf:
                    creative_perf[key] = {"visitors": 0, "conversions": 0, "revenue": 0.0}
                creative_perf[key]["visitors"] += 1
                if v.paid or v.signed_up:
                    creative_perf[key]["conversions"] += 1
                creative_perf[key]["revenue"] += v.deal_value

            report["brands"][brand_key] = {
                "total_visitors": len(visitors),
                "total_revenue": sum(v.deal_value for v in visitors),
                "creative_performance": creative_perf,
            }
        return report

    # ── Export ──

    def export_state(self) -> dict[str, Any]:
        return {
            "timestamp": datetime.utcnow().isoformat(),
            "brands": {k: self._brand_state_to_dict(v) for k, v in self.brands.items()},
            "decisions_today": len(self.decisions),
            "alerts_today": len(self.alerts),
            "alerts": self.alerts,
        }

    # ── Helpers ──

    def _brand_state_to_dict(self, state: BrandState) -> dict[str, Any]:
        return {
            "phase": state.phase.value,
            "daily_budget": state.daily_budget,
            "total_spend": state.total_spend_to_date,
            "total_revenue": state.total_revenue_to_date,
            "cpa": state.current_cpa,
            "roas": state.current_roas,
            "mrr": state.current_mrr,
            "active_customers": state.active_customers,
            "avg_ltv": state.avg_ltv,
            "max_cac": state.max_allowable_cac,
            "roi": state.roi,
        }

    def _decision_to_dict(self, d: OptimizationDecision) -> dict[str, Any]:
        return {
            "timestamp": d.timestamp,
            "brand": d.brand,
            "decision_type": d.decision_type,
            "target": d.target,
            "action": d.action,
            "metrics": d.metrics,
            "executed": d.executed,
        }


# ══════════════════════════════════════════════════════════════════════════════
# Experiment Policy — Deterministic Daily Executor
# ══════════════════════════════════════════════════════════════════════════════


def run_experiment_policy_daily(
    *,
    conn: sqlite3.Connection,
    policy_path: str | Path | None = None,
    safe_mode: bool = True,
    write_lock: bool = True,
    correlation_id: str | None = None,
    now_ts: str | None = None,
) -> dict[str, Any]:
    """Deterministic daily policy executor.

    - Loads experiment_policy.yaml
    - Pulls metrics per combo over evaluation window
    - Applies hold/kill/scale/fatigue rules
    - Enforces max actions and cooldown gates

    Uses conn pattern matching codebase convention.
    """
    correlation_id = correlation_id or f"policy-{int(time.time())}"
    now_ts = now_ts or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    state = SystemState(conn)
    breaker = CircuitBreaker(conn)

    # Circuit breaker cooldown gate
    active, until, reason = breaker.cooldown_active()
    if active:
        return {
            "ok": True,
            "simulate": True,
            "blocked_reason": f"cooldown active until={until} reason={reason}",
            "correlation_id": correlation_id,
            "ts": now_ts,
            "actions": [],
            "warnings": ["cooldown active"],
        }

    # Policy load
    resolved_path = Path(policy_path) if policy_path else _DEFAULT_POLICY_PATH
    with open(resolved_path, encoding="utf-8") as f:
        policy: dict[str, Any] = yaml.safe_load(f)

    # Write-lock gate
    if policy["global"].get("require_write_unlock", True) and write_lock:
        return {
            "ok": True,
            "simulate": True,
            "blocked_reason": "write_lock=true",
            "correlation_id": correlation_id,
            "ts": now_ts,
            "actions": [],
            "warnings": ["write_lock active"],
        }

    # Pull metrics
    global_caps = policy["global"]
    brand_cfg = policy["brands"]

    ledger = AttributionLedger(conn)
    metrics_by_combo = aggregate_combo_metrics_contract(ledger=ledger, policy=policy)

    # Evaluate combos per brand
    actions: list[dict[str, Any]] = []
    traces: list[DecisionTrace] = []
    max_actions = int(global_caps.get("max_actions_per_run", 25))

    for brand in ("cutmv", "fulldigital"):
        brand_metrics = [m for m in metrics_by_combo if m.brand == brand]

        # Cap active combos (prefer highest spend/recent activity)
        brand_metrics = sorted(brand_metrics, key=lambda m: m.spend_usd, reverse=True)
        brand_limit = int(
            brand_cfg[brand].get("max_active_combos", global_caps["max_active_combos"])
        )
        active_combos = brand_metrics[:brand_limit]

        # Compute baselines
        baseline_cpa, baseline_ctr, baseline_cpm = compute_brand_baselines(
            active_combos, policy, brand
        )

        # Apply rules (in priority order)
        for m in active_combos:
            if len(actions) >= max_actions:
                break

            decision, detail = decide_combo_action(
                m=m,
                policy=policy,
                brand=brand,
                baseline_cpa=baseline_cpa,
                baseline_ctr=baseline_ctr,
                baseline_cpm=baseline_cpm,
            )

            # Build trace for every combo (including None decisions)
            trace = DecisionTrace(
                combo_id=m.combo_id,
                brand=brand,
                final_decision=decision or "no_action",
                input_metrics={
                    "impressions": m.impressions,
                    "clicks": m.clicks,
                    "conversions": m.conversions,
                    "spend_usd": m.spend_usd,
                    "cpa": m.cpa,
                    "roas": m.roas,
                    "ctr": m.ctr,
                    "cpm": m.cpm,
                    "frequency": m.frequency,
                },
            )
            trace.add_step(
                "decide_combo_action",
                decision or "no_action",
                **detail,
            )
            traces.append(trace)

            if decision is None:
                continue

            action = {
                "combo_id": m.combo_id,
                "brand": brand,
                "decision": decision,
                "detail": detail,
                "simulate": safe_mode,
            }
            actions.append(action)

            # Apply to Meta Ads engine (if not safe_mode)
            if not safe_mode:
                apply_action_to_meta_ads(
                    combo_id=m.combo_id, decision=decision, detail=detail
                )

    # Apply Full Digital quality gate (post-processor on scale decisions)
    from packages.agencyu.marketing.quality_gate import apply_quality_gate

    gate_blocks: list[dict[str, Any]] = []
    metrics_by_id = {m.combo_id: m for m in metrics_by_combo}

    for i, action in enumerate(actions):
        if action["brand"] != "fulldigital":
            continue
        m = metrics_by_id.get(action["combo_id"])
        if not isinstance(m, ComboMetricsFD):
            continue
        gated_action, block = apply_quality_gate(action, m, policy)
        if block:
            actions[i] = gated_action
            gate_blocks.append(block)

    # ── Advanced Signal Pipeline (Strategic Intelligence Brief upgrades) ──
    signal_results = apply_advanced_signals(
        actions=actions,
        metrics_by_id=metrics_by_id,
        policy=policy,
        conn=conn,
        now_ts=now_ts,
    )

    # Store queue depth snapshot
    current_depth = state.get_int(SystemKeys.QUEUE_DEPTH_SCHEDULED_ACTIONS, 0) or 0
    state.set_int(SystemKeys.QUEUE_DEPTH_SCHEDULED_ACTIONS, current_depth + len(actions))

    # Build daily report (includes FD dual-conversion leaderboard + gate blocks)
    from packages.agencyu.marketing.reporting import render_daily_report

    report_cfg = policy.get("reporting", {})
    top_n = int(report_cfg.get("include_top_n", 5))
    report = render_daily_report(
        metrics_by_combo, actions, top_n=top_n, gate_blocks=gate_blocks,
    )
    report["advanced_signals"] = signal_results

    # ── Brand Switcher KPI badges (Today vs Yesterday) ──
    from packages.agencyu.marketing.metrics_daily import (
        build_brand_tile_summary,
        delta_arrow,
        trend_color,
    )

    tile_summary = build_brand_tile_summary(conn)
    fd_s = tile_summary["fulldigital"]
    cm_s = tile_summary["cutmv"]
    fd_delta = fd_s["calls_booked_today"] - fd_s["calls_booked_yesterday"]
    cm_delta = cm_s["paid_today"] - cm_s["paid_yesterday"]

    report["brand_switcher_kpis"] = {
        "title": "Brand Summary (Today vs Yesterday)",
        "lines": [
            (
                f"Full Digital \u2014 Today \u2022 {fd_s['calls_booked_today']} booked calls"
                f"  {delta_arrow(fd_delta)} {fd_delta:+d} vs yesterday"
            ),
            (
                f"CUTMV \u2014 Today \u2022 {cm_s['trials_today']} trials"
                f" \u2022 {cm_s['paid_today']} paid"
                f"  {delta_arrow(cm_delta)} {cm_delta:+d} vs yesterday"
            ),
        ],
        "data": tile_summary,
        "admin_chip_colors": {
            "fulldigital": trend_color(fd_delta),
            "cutmv": trend_color(cm_delta),
        },
    }

    # ── Goals + Schedule (Executive Operating System) ──
    from packages.agencyu.schedule.repo import GoalRepo
    from packages.agencyu.schedule.sync_engine import run_daily_sync

    goal_repo = GoalRepo(conn)
    goal_chips: dict[str, str] = {}
    for brand_key in ("fulldigital", "cutmv"):
        chip = goal_repo.build_goal_chip(brand_key, "daily")
        if chip:
            goal_chips[brand_key] = chip.chip_text

    daily_sync_result = run_daily_sync(conn)

    report["executive_os"] = {
        "title": "Executive Operating System",
        "goal_chips": goal_chips,
        "daily_plans": daily_sync_result.get("plans", {}),
    }

    # ── Leverage Layers (authority, expansion, capacity, offers, VSL) ──
    leverage: dict[str, Any] = {}

    try:
        from packages.agencyu.marketing.authority_engine import authority_score as _auth_score

        leverage["authority"] = {
            brand_key: {
                "score": s.overall,
                "engagement": s.engagement_score,
                "frequency": s.frequency_score,
                "dm_triggers": s.dm_trigger_score,
                "booking_influence": s.booking_influence_score,
            }
            for brand_key in ("fulldigital", "cutmv")
            if (s := _auth_score(conn, brand_key))
        }
    except Exception:
        leverage["authority"] = {"error": "unavailable"}

    try:
        from packages.agencyu.marketing.expansion_engine import scan_expansion_triggers

        expansion = scan_expansion_triggers(conn)
        leverage["expansion"] = {
            "trigger_count": len(expansion.triggers),
            "by_type": expansion.by_type,
            "potential_revenue_cents": expansion.total_potential_revenue_cents,
        }
    except Exception:
        leverage["expansion"] = {"error": "unavailable"}

    try:
        from packages.agencyu.sync.capacity_engine import run_capacity_report

        cap = run_capacity_report(conn)
        leverage["capacity"] = {
            "utilization": cap.overview.get("utilization", 0),
            "at_risk_roles": sum(1 for r in cap.by_role if r.at_risk),
            "hiring_recommendations": len(cap.hiring),
            "scaling_blocked": cap.scaling_blocked,
        }
    except Exception:
        leverage["capacity"] = {"error": "unavailable"}

    try:
        from packages.agencyu.marketing.offer_rotation import rotate_offer as _rotate

        leverage["offer_rotation"] = {
            brand_key: _rotate(conn, brand_key)
            for brand_key in ("fulldigital", "cutmv")
        }
    except Exception:
        leverage["offer_rotation"] = {"error": "unavailable"}

    try:
        from packages.agencyu.marketing.vsl_optimizer import run_vsl_optimization_cycle

        vsl_result = run_vsl_optimization_cycle(conn)
        leverage["vsl"] = {
            "vsl_count": vsl_result.get("vsl_count", 0),
            "winners": vsl_result.get("winners", []),
            "needs_data": vsl_result.get("needs_data", []),
        }
    except Exception:
        leverage["vsl"] = {"error": "unavailable"}

    try:
        from packages.agencyu.finance.profit_engine import run_profit_report

        profit = run_profit_report(conn)
        leverage["profit"] = profit.summary
    except Exception:
        leverage["profit"] = {"error": "unavailable"}

    # ── Optimization Engines (offer angles, authority scheduler, setter router, retainer) ──

    try:
        from packages.agencyu.marketing.offer_angles import run_rotation_cycle

        offer_angle_results: dict[str, Any] = {}
        for brand_key in ("fulldigital", "cutmv"):
            offer_angle_results[brand_key] = run_rotation_cycle(
                conn, brand_key, safe_mode=safe_mode,
            )
        leverage["offer_angles"] = offer_angle_results
    except Exception:
        leverage["offer_angles"] = {"error": "unavailable"}

    try:
        from packages.agencyu.marketing.authority_scheduler import (
            get_weekly_authority_report,
            seed_content_queue,
        )

        authority_sched: dict[str, Any] = {}
        for brand_key in ("fulldigital", "cutmv"):
            report_data = get_weekly_authority_report(conn, brand_key)
            authority_sched[brand_key] = {
                "report": report_data,
            }
            # Seed content queue on Mondays or if queue is empty
            if datetime.utcnow().weekday() == 0:  # Monday
                seed_result = seed_content_queue(conn, brand_key, safe_mode=safe_mode)
                authority_sched[brand_key]["seed_result"] = seed_result
        leverage["authority_scheduler"] = authority_sched
    except Exception:
        leverage["authority_scheduler"] = {"error": "unavailable"}

    try:
        from packages.agencyu.marketing.setter_router import rank_setters as _rank_setters

        setter_routing: dict[str, Any] = {}
        for brand_key in ("fulldigital", "cutmv"):
            candidates = _rank_setters(conn, brand_key)
            setter_routing[brand_key] = {
                "active_setters": len(candidates),
                "top_3": [
                    {
                        "name": c.display_name,
                        "score": round(c.composite_score, 1),
                        "available": c.available,
                    }
                    for c in candidates[:3]
                ],
            }
        leverage["setter_routing"] = setter_routing
    except Exception:
        leverage["setter_routing"] = {"error": "unavailable"}

    try:
        from packages.agencyu.marketing.retainer_funnel import run_retainer_scan

        retainer_result = run_retainer_scan(conn, safe_mode=safe_mode)
        leverage["retainer_funnel"] = {
            "candidates_found": len(retainer_result.get("results", [])),
            "applied": retainer_result.get("applied", 0),
            "safe_mode": retainer_result.get("safe_mode", True),
        }
    except Exception:
        leverage["retainer_funnel"] = {"error": "unavailable"}

    # ── Primary Offer Focus Evaluation ──
    try:
        leverage["primary_offer_focus"] = _evaluate_primary_offer_focus(
            conn=conn,
            profit_summary=leverage.get("profit", {}),
            authority_data=leverage.get("authority", {}),
        )
    except Exception:
        leverage["primary_offer_focus"] = {"error": "unavailable"}

    report["leverage_layers"] = leverage

    return {
        "ok": True,
        "simulate": safe_mode,
        "correlation_id": correlation_id,
        "ts": now_ts,
        "actions": actions,
        "warnings": build_policy_warnings(policy, metrics_by_combo),
        "report": report,
        "traces": [t.to_dict() for t in traces],
        "brand_switcher_kpis": tile_summary,
        "goal_chips": goal_chips,
    }


# ── Contracts / helpers (deterministic) ──


def aggregate_combo_metrics_contract(
    *, ledger: AttributionLedger, policy: dict[str, Any]
) -> list[ComboMetrics]:
    """Aggregate combo metrics from Meta Insights + Attribution Ledger.

    Uses Option A binding: Meta Insights API for ad performance (CTR/CPM/
    Frequency/Spend) joined with Attribution Ledger for conversions + revenue.

    Falls back to empty list when Meta credentials are not configured.
    """
    meta_token = os.environ.get("META_ACCESS_TOKEN", "")
    meta_account = os.environ.get("META_AD_ACCOUNT_ID", "")

    if not meta_token or not meta_account:
        log.info("meta_credentials_not_configured_skipping_aggregation")
        return []

    from packages.agencyu.integrations.meta_insights import (
        MetaInsightsClient,
        MetaInsightsConfig,
    )
    from packages.agencyu.marketing.metrics_aggregator import (
        AggregatorConfig,
        MetricsAggregator,
        compute_evaluation_window,
    )

    meta_cfg = MetaInsightsConfig(
        access_token=meta_token,
        ad_account_id=meta_account,
    )
    meta = MetaInsightsClient(meta_cfg)
    agg = MetricsAggregator(meta=meta, ledger=ledger, policy=policy)

    window_hours = int(
        policy.get("measurement", {})
        .get("sample_windows", {})
        .get("evaluation_window_hours", 72)
    )
    since, until = compute_evaluation_window(window_hours)

    all_metrics: list[ComboMetrics] = []
    for brand in ("cutmv", "fulldigital"):
        all_metrics.extend(
            agg.aggregate(AggregatorConfig(brand=brand, since=since, until=until))
        )
    return all_metrics


def compute_brand_baselines(
    active: list[ComboMetrics],
    policy: dict[str, Any],
    brand: str,
) -> tuple[float, float, float]:
    """Compute median CPA/CTR/CPM from winners, or fallback baselines."""
    winners = [m for m in active if m.conversions > 0 and m.spend_usd > 0]
    if winners:
        cpas = sorted([m.cpa for m in winners if m.cpa > 0])
        ctrs = sorted([m.ctr for m in winners if m.ctr > 0])
        cpms = sorted([m.cpm for m in winners if m.cpm > 0])

        def _median(arr: list[float]) -> float:
            return arr[len(arr) // 2] if arr else 0.0

        return (
            _median(cpas) or _fallback_cpa(policy, brand),
            _median(ctrs) or 0.01,
            _median(cpms) or 10.0,
        )

    return _fallback_cpa(policy, brand), 0.01, 10.0


def _fallback_cpa(policy: dict[str, Any], brand: str) -> float:
    fb = policy.get("fallback_baselines", {}).get(brand, {})
    return float(fb.get("target_cpa_usd", 50))


def decide_combo_action(
    *,
    m: ComboMetrics,
    policy: dict[str, Any],
    brand: str,
    baseline_cpa: float,
    baseline_ctr: float,
    baseline_cpm: float,
) -> tuple[str | None, dict[str, Any]]:
    """Deterministic rule evaluation for a single combo.

    Priority order: hold → kill (zero-conv) → kill (CPA 3x) → fatigue → scale.
    """
    meas = policy["measurement"]
    mins: dict[str, Any] = dict(meas["minimums"])
    mins.update(policy["brands"][brand].get("min_sample_overrides", {}) or {})

    # HOLD if minimum samples not met
    if policy["rules"]["hold"]["enabled"]:
        if (
            m.impressions < int(mins["min_impressions"])
            or m.clicks < int(mins["min_clicks"])
            or m.spend_usd < float(mins["min_spend_usd"])
        ):
            return None, {"reason": "hold_minimums_not_met", "mins": mins}

    # KILL: zero conversion high spend guard
    kill_cfg = policy["rules"]["kill"]
    if kill_cfg["enabled"] and kill_cfg["zero_conversion"]["enabled"]:
        z = kill_cfg["zero_conversion"]
        if (
            m.conversions == 0
            and m.spend_usd >= float(z["spend_threshold_usd"])
            and m.clicks >= int(z["min_clicks"])
        ):
            return z["action"], {
                "reason": "zero_conversion_guard",
                "spend": m.spend_usd,
                "clicks": m.clicks,
            }

    # KILL: CPA multiplier threshold
    if kill_cfg["enabled"]:
        mult = float(kill_cfg["cpa_multiplier_threshold"])
        if m.conversions >= int(mins.get("min_conversions", 1)) and m.cpa > (
            baseline_cpa * mult
        ):
            return "pause", {
                "reason": "kill_cpa_3x",
                "cpa": m.cpa,
                "baseline_cpa": baseline_cpa,
                "mult": mult,
            }

    # CREATIVE FATIGUE
    fat = policy.get("creative_fatigue", {})
    if fat.get("enabled", False):
        th = fat["thresholds"]
        ctr_drop = _pct_drop(baseline_ctr, m.ctr)
        cpm_inc = _pct_increase(baseline_cpm, m.cpm)
        if (
            ctr_drop >= float(th["ctr_drop_pct"])
            or cpm_inc >= float(th["cpm_increase_pct"])
            or m.frequency >= float(th["frequency_threshold"])
        ):
            return fat["actions"]["on_fatigue"], {
                "reason": "creative_fatigue",
                "ctr_drop_pct": ctr_drop,
                "cpm_increase_pct": cpm_inc,
                "frequency": m.frequency,
            }

    # SCALE: ROAS threshold
    scale_cfg = policy["rules"]["scale"]
    if scale_cfg["enabled"]:
        if m.conversions >= int(mins.get("min_conversions", 1)) and m.roas >= float(
            scale_cfg["roas_threshold"]
        ):
            return "scale_budget", {
                "reason": "scale_roas_2x",
                "roas": m.roas,
                "max_scale_step_pct": float(scale_cfg["max_scale_step_pct"]),
                "max_total_scale_pct_per_day": float(
                    scale_cfg["max_total_scale_pct_per_day"]
                ),
            }

    return None, {}


def _pct_drop(baseline: float, current: float) -> float:
    if baseline <= 0:
        return 0.0
    return max(0.0, (baseline - current) / baseline * 100.0)


def _pct_increase(baseline: float, current: float) -> float:
    if baseline <= 0:
        return 0.0
    return max(0.0, (current - baseline) / baseline * 100.0)


def apply_action_to_meta_ads(
    combo_id: str, decision: str, detail: dict[str, Any]
) -> None:
    """Wire into engines/meta_ads.py.

    Must be rate-limited + idempotent.
    TODO: integrate with MetaAdsManager:
    - pause_combo(combo_id)
    - scale_combo_budget(combo_id, pct_step)
    - rotate_creative(combo_id)
    """


def apply_advanced_signals(
    *,
    actions: list[dict[str, Any]],
    metrics_by_id: dict[str, ComboMetrics],
    policy: dict[str, Any],
    conn: sqlite3.Connection,
    now_ts: str,
) -> dict[str, Any]:
    """Apply advanced policy signals as weighted modifiers on scaling decisions.

    Runs after quality gates. Applies in order:
    1. Angle fatigue detection → SCALE → rotate_creative
    2. Close-rate volatility (Beta CI) → SCALE → scale_soft or hold
    3. CAC payback gate → SCALE → hold

    Returns signal diagnostics for the report.
    """
    from packages.agencyu.marketing.fatigue import detect_fatigue
    from packages.agencyu.marketing.payback import payback_gate_one_time
    from packages.agencyu.marketing.revenue_forecast import (
        beta_ci,
        scaling_confidence_from_uncertainty,
    )

    from packages.agencyu.operations.capacity_gate import capacity_ok_to_scale

    results: dict[str, Any] = {
        "capacity_blocks": [],
        "fatigue_rotations": [],
        "volatility_downgrades": [],
        "payback_blocks": [],
    }

    fatigue_cfg = policy.get("angle_fatigue", {})
    forecast_cfg = policy.get("forecasting", {})
    volatility_cfg = forecast_cfg.get("close_rate_volatility", {})
    payback_cfg = policy.get("payback", {})

    # Pre-compute capacity gate per brand (avoid repeated DB queries)
    _capacity_cache: dict[str, tuple[bool, str, dict[str, Any]]] = {}

    for i, action in enumerate(actions):
        if action.get("decision") not in ("scale_budget", "scale_soft"):
            continue

        combo_id = action["combo_id"]
        brand = action["brand"]
        m = metrics_by_id.get(combo_id)
        if m is None:
            continue

        # ── B6: Capacity gate (runs first — blocks scaling if fulfillment constrained) ──
        if brand not in _capacity_cache:
            _capacity_cache[brand] = capacity_ok_to_scale(conn, brand, policy)
        cap_ok, cap_msg, cap_data = _capacity_cache[brand]
        if not cap_ok:
            actions[i] = {
                **action,
                "decision": "hold",
                "detail": {
                    **action.get("detail", {}),
                    "reason": "capacity_gate",
                    "capacity_message": cap_msg,
                    "capacity_data": {
                        k: v for k, v in cap_data.items()
                        if k in ("brand", "known", "headroom_ratio", "free_hours")
                    },
                },
            }
            results["capacity_blocks"].append({
                "combo_id": combo_id,
                "brand": brand,
                "message": cap_msg,
            })
            continue  # Don't apply further signals to capacity-blocked combos

        # ── B4: Angle fatigue detection ──
        if fatigue_cfg.get("enabled", False) and action["decision"] == "scale_budget":
            sig = detect_fatigue(
                frequency=m.frequency,
                ctr_now=m.ctr,
                ctr_prev=m.ctr * 1.2,  # TODO: use previous-period CTR from ledger
                cpc_now=(m.spend_usd / m.clicks) if m.clicks > 0 else 0,
                cpc_prev=(m.spend_usd / m.clicks * 0.8) if m.clicks > 0 else 0,
                freq_threshold=float(fatigue_cfg.get("frequency_threshold", 2.8)),
                ctr_drop_pct=float(fatigue_cfg.get("ctr_drop_pct", 35)),
                cpc_increase_pct=float(fatigue_cfg.get("cpc_increase_pct", 40)),
                min_signals=int(fatigue_cfg.get("min_signals", 2)),
            )
            if sig.fatigued:
                fatigue_action = fatigue_cfg.get("action", "rotate_creative")
                actions[i] = {
                    **action,
                    "decision": fatigue_action,
                    "detail": {
                        **action.get("detail", {}),
                        "reason": "angle_fatigue",
                        "fatigue_signals": sig.reasons,
                    },
                }
                results["fatigue_rotations"].append({
                    "combo_id": combo_id,
                    "brand": brand,
                    "reasons": sig.reasons,
                })
                continue  # Don't apply further signals to rotated combos

        # ── B1: Close-rate volatility (Full Digital only) ──
        if (
            volatility_cfg.get("enabled", False)
            and isinstance(m, ComboMetricsFD)
            and brand == "fulldigital"
            and action["decision"] == "scale_budget"
        ):
            min_calls = int(volatility_cfg.get("min_calls_for_model", 30))
            if m.calls_observed >= min_calls:
                penalty_weight = float(volatility_cfg.get("penalty_weight", 0.35))
                unc = beta_ci(
                    m.revenue_conversions,
                    m.calls_observed,
                    iterations=int(forecast_cfg.get("monte_carlo", {}).get("iterations", 1000)),
                )
                confidence = scaling_confidence_from_uncertainty(unc, penalty_weight)

                hold_thr = float(volatility_cfg.get("hold_threshold", 0.25))
                soft_thr = float(volatility_cfg.get("scale_soft_threshold", 0.50))

                if confidence < hold_thr:
                    actions[i] = {
                        **action,
                        "decision": "hold",
                        "detail": {
                            **action.get("detail", {}),
                            "reason": "close_rate_volatility_hold",
                            "confidence": round(confidence, 3),
                            "ci_width": round(unc.width, 4),
                        },
                    }
                    results["volatility_downgrades"].append({
                        "combo_id": combo_id,
                        "confidence": round(confidence, 3),
                        "action": "hold",
                    })
                    continue
                elif confidence < soft_thr:
                    actions[i] = {
                        **action,
                        "decision": "scale_soft",
                        "detail": {
                            **action.get("detail", {}),
                            "reason": "close_rate_volatility_soft",
                            "confidence": round(confidence, 3),
                            "ci_width": round(unc.width, 4),
                        },
                    }
                    results["volatility_downgrades"].append({
                        "combo_id": combo_id,
                        "confidence": round(confidence, 3),
                        "action": "scale_soft",
                    })

        # ── B5: CAC payback gate ──
        if (
            payback_cfg.get("enabled", False)
            and actions[i].get("decision") in ("scale_budget", "scale_soft")
        ):
            brand_payback = payback_cfg.get(brand, {})
            gross_margin = float(brand_payback.get("gross_margin", 0.70))
            max_pb_days = int(brand_payback.get("max_payback_days", 30))

            if isinstance(m, ComboMetricsFD) and m.revenue_conversions > 0:
                cac = m.spend_usd / m.revenue_conversions
                avg_rev = m.revenue_usd / m.revenue_conversions
                pb = payback_gate_one_time(
                    cac=cac,
                    net_revenue=avg_rev,
                    gross_margin=gross_margin,
                    max_payback_days=max_pb_days,
                )
                if not pb.ok:
                    actions[i] = {
                        **action,
                        "decision": "hold",
                        "detail": {
                            **action.get("detail", {}),
                            "reason": "payback_exceeds_horizon",
                            "payback_days": pb.payback_days,
                            "max_payback_days": max_pb_days,
                        },
                    }
                    results["payback_blocks"].append({
                        "combo_id": combo_id,
                        "brand": brand,
                        "payback_days": pb.payback_days,
                        "reason": pb.reason,
                    })

    return results


def build_policy_warnings(
    policy: dict[str, Any], metrics: list[ComboMetrics]
) -> list[str]:
    warnings: list[str] = []
    if not metrics:
        warnings.append(
            "no combo metrics available (aggregation not implemented or no data yet)"
        )
    return warnings


# ── Primary Offer Focus Evaluation ──


def _evaluate_primary_offer_focus(
    *,
    conn: sqlite3.Connection,
    profit_summary: dict[str, Any],
    authority_data: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate whether the primary anchor offer should be scaled, held, or pivoted.

    Checks three signals:
    1. Profit margin — margin floor met?
    2. Authority score — brand trust sufficient?
    3. Demand signal — recent conversion volume for the anchor offer.

    Returns a recommendation: scale | hold | pivot.
    """
    from packages.agencyu.marketing.offer_angles import load_offers_config

    offers_cfg = load_offers_config()
    primary = None
    for offer in offers_cfg.get("offers", []):
        if offer.get("primary_anchor"):
            primary = offer
            break

    if primary is None:
        return {"recommendation": "no_primary_anchor_configured"}

    offer_id = primary["id"]

    # Signal 1: Profit margin
    margin_floor = float(primary.get("margin_floor", 0.35))
    brand_margins = profit_summary.get("brand_margins", {})
    fd_margin = float(brand_margins.get("fulldigital", {}).get("gross_margin", 0))

    margin_ok = fd_margin >= margin_floor

    # Signal 2: Authority score
    fd_auth = authority_data.get("fulldigital", {})
    auth_score = float(fd_auth.get("score", 0)) if isinstance(fd_auth, dict) else 0
    auth_ok = auth_score >= 50

    # Signal 3: Demand (recent conversions for this offer)
    demand_count = 0
    try:
        row = conn.execute(
            """SELECT COUNT(*) AS cnt FROM attribution_events
               WHERE offer_id = ? AND event_type = 'conversion'
               AND created_at >= datetime('now', '-30 days')""",
            (offer_id,),
        ).fetchone()
        demand_count = int(row["cnt"]) if row else 0
    except Exception:
        pass

    demand_ok = demand_count >= 3

    # Decision
    signals_met = sum([margin_ok, auth_ok, demand_ok])
    if signals_met >= 3:
        recommendation = "scale"
    elif signals_met >= 2:
        recommendation = "hold"
    else:
        recommendation = "pivot"

    return {
        "offer_id": offer_id,
        "offer_name": primary.get("name", offer_id),
        "recommendation": recommendation,
        "signals": {
            "margin": {"ok": margin_ok, "value": fd_margin, "floor": margin_floor},
            "authority": {"ok": auth_ok, "value": auth_score, "threshold": 50},
            "demand": {"ok": demand_ok, "value": demand_count, "threshold": 3},
        },
        "signals_met": signals_met,
    }
