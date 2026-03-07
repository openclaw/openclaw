"""LTV & Retention Engine — Customer lifetime value, churn prediction, retention triggers.

Full Digital LLC — CUTMV + Full Digital.
Tracks LTV (actual + projected + risk-adjusted), churn prediction scoring,
brand-specific retention actions, cross-sell detection, and max CAC calculation.

Feeds into brain.py for spend optimization (knowing LTV informs max CAC).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import StrEnum
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.engines.ltv_retention")


class CustomerStatus(StrEnum):
    TRIAL = "trial"
    ACTIVE = "active"
    AT_RISK = "at_risk"
    CHURNED = "churned"
    PAUSED = "paused"
    EXPANSION = "expansion"


class ChurnRisk(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class Customer:
    """A paying customer (CUTMV subscriber or Full Digital client)."""

    id: str
    brand: str
    name: str
    email: str
    plan: str
    mrr: float
    start_date: date
    status: CustomerStatus = CustomerStatus.ACTIVE
    # Engagement signals
    last_login: date | None = None
    last_upload: date | None = None
    videos_processed_30d: int = 0
    last_deliverable: date | None = None
    last_meeting: date | None = None
    last_communication: date | None = None
    nps_score: int | None = None
    support_tickets_30d: int = 0
    # Financial
    total_revenue: float = 0.0
    months_active: int = 0
    expansion_revenue: float = 0.0
    source_campaign: str = ""
    # Churn
    churn_risk: ChurnRisk = ChurnRisk.LOW
    churn_risk_score: float = 0.0
    churn_date: date | None = None


@dataclass
class RetentionAction:
    """An automated retention action to take."""

    customer_id: str
    action_type: str
    trigger: str
    message: str
    priority: str
    due_date: date
    completed: bool = False


class LTVRetentionEngine:
    """Core engine for LTV calculation, churn prediction, and retention triggers."""

    def __init__(self) -> None:
        self.customers: dict[str, Customer] = {}
        self.retention_queue: list[RetentionAction] = []

    def add_customer(self, customer: Customer) -> None:
        self.customers[customer.id] = customer

    # ── LTV Calculations ──

    def calculate_ltv(self, customer_id: str) -> dict[str, Any]:
        c = self.customers.get(customer_id)
        if not c:
            return {"error": "Customer not found"}

        actual_ltv = c.total_revenue + c.expansion_revenue

        risk_multipliers = {
            ChurnRisk.LOW: 1.0,
            ChurnRisk.MEDIUM: 0.7 if c.brand == "cutmv" else 0.65,
            ChurnRisk.HIGH: 0.4 if c.brand == "cutmv" else 0.3,
            ChurnRisk.CRITICAL: 0.15 if c.brand == "cutmv" else 0.1,
        }

        if c.brand == "cutmv":
            avg_lifetime = 8
            remaining = max(0, avg_lifetime - c.months_active)
            projected_ltv = actual_ltv + (c.mrr * remaining)
            risk_adjusted_ltv = actual_ltv + (c.mrr * remaining * risk_multipliers[c.churn_risk])
        elif c.brand == "fulldigital":
            avg_lifetime = 6
            remaining = max(0, avg_lifetime - c.months_active)
            expansion_potential = c.mrr * 0.3 * remaining
            projected_ltv = actual_ltv + (c.mrr * remaining) + expansion_potential
            risk_adjusted_ltv = actual_ltv + (
                (c.mrr * remaining + expansion_potential) * risk_multipliers[c.churn_risk]
            )
        else:
            projected_ltv = actual_ltv
            risk_adjusted_ltv = actual_ltv

        return {
            "customer_id": customer_id,
            "brand": c.brand,
            "actual_ltv": round(actual_ltv, 2),
            "projected_ltv": round(projected_ltv, 2),
            "risk_adjusted_ltv": round(risk_adjusted_ltv, 2),
            "months_active": c.months_active,
            "current_mrr": c.mrr,
            "churn_risk": c.churn_risk.value,
            "expansion_revenue": c.expansion_revenue,
        }

    def calculate_cohort_ltv(self, brand: str, cohort_month: str) -> dict[str, Any]:
        cohort = [
            c for c in self.customers.values()
            if c.brand == brand and c.start_date.strftime("%Y-%m") == cohort_month
        ]
        if not cohort:
            return {"error": "No customers in this cohort"}

        ltvs = [self.calculate_ltv(c.id) for c in cohort]
        active = [c for c in cohort if c.status == CustomerStatus.ACTIVE]

        return {
            "brand": brand,
            "cohort_month": cohort_month,
            "total_customers": len(cohort),
            "active": len(active),
            "churned": sum(1 for c in cohort if c.status == CustomerStatus.CHURNED),
            "retention_rate": round(len(active) / len(cohort) * 100, 1),
            "avg_actual_ltv": round(sum(l["actual_ltv"] for l in ltvs) / len(ltvs), 2),
            "avg_projected_ltv": round(sum(l["projected_ltv"] for l in ltvs) / len(ltvs), 2),
            "total_revenue": round(sum(c.total_revenue for c in cohort), 2),
            "avg_mrr": round(sum(c.mrr for c in active) / len(active), 2) if active else 0,
        }

    # ── Churn Prediction ──

    def predict_churn_risk(self, customer_id: str) -> dict[str, Any]:
        c = self.customers.get(customer_id)
        if not c:
            return {"error": "Customer not found"}

        risk_score = 0
        signals: list[str] = []
        today = date.today()

        if c.brand == "cutmv":
            if c.last_login and (today - c.last_login).days > 7:
                days_inactive = (today - c.last_login).days
                risk_score += min(30, days_inactive * 2)
                signals.append(f"No login in {days_inactive} days")
            if c.last_upload and (today - c.last_upload).days > 14:
                risk_score += 20
                signals.append(f"No uploads in {(today - c.last_upload).days} days")
            if c.plan in ("pro", "agency") and c.videos_processed_30d < 3:
                risk_score += 15
                signals.append(f"Only {c.videos_processed_30d} videos (underutilizing {c.plan})")
            if c.support_tickets_30d >= 3:
                risk_score += 15
                signals.append(f"{c.support_tickets_30d} support tickets in 30d")
            if c.nps_score is not None and c.nps_score <= 5:
                risk_score += 20
                signals.append(f"NPS score: {c.nps_score}/10")
        elif c.brand == "fulldigital":
            if c.last_communication and (today - c.last_communication).days > 14:
                days_silent = (today - c.last_communication).days
                risk_score += min(25, days_silent)
                signals.append(f"No communication in {days_silent} days")
            if c.last_deliverable and (today - c.last_deliverable).days > 21:
                risk_score += 20
                signals.append(f"No deliverables in {(today - c.last_deliverable).days} days")
            if c.last_meeting and (today - c.last_meeting).days > 30:
                risk_score += 15
                signals.append(f"No meeting in {(today - c.last_meeting).days} days")
            if c.support_tickets_30d >= 2:
                risk_score += 15
                signals.append(f"{c.support_tickets_30d} support tickets in 30d")
            if c.nps_score is not None and c.nps_score <= 6:
                risk_score += 25
                signals.append(f"NPS score: {c.nps_score}/10")

        risk_score = min(100, risk_score)

        if risk_score >= 75:
            risk_level = ChurnRisk.CRITICAL
        elif risk_score >= 50:
            risk_level = ChurnRisk.HIGH
        elif risk_score >= 25:
            risk_level = ChurnRisk.MEDIUM
        else:
            risk_level = ChurnRisk.LOW

        c.churn_risk = risk_level
        c.churn_risk_score = risk_score

        return {
            "customer_id": customer_id,
            "name": c.name,
            "brand": c.brand,
            "risk_score": risk_score,
            "risk_level": risk_level.value,
            "signals": signals,
            "recommended_actions": self._get_retention_actions(c, risk_level),
        }

    def _get_retention_actions(self, customer: Customer, risk: ChurnRisk) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        if customer.brand == "cutmv":
            if risk == ChurnRisk.CRITICAL:
                actions.append({"action": "Send personal DM", "channel": "instagram_dm", "priority": "critical"})
                actions.append({"action": "Offer 30-day free extension", "channel": "email", "priority": "critical"})
            elif risk == ChurnRisk.HIGH:
                actions.append({"action": "Feature highlight email", "channel": "email", "priority": "high"})
                actions.append({"action": "Usage nudge DM", "channel": "instagram_dm", "priority": "high"})
            elif risk == ChurnRisk.MEDIUM:
                actions.append({"action": "Case study email", "channel": "email", "priority": "medium"})
        elif customer.brand == "fulldigital":
            if risk == ChurnRisk.CRITICAL:
                actions.append({"action": "DA personal call", "channel": "phone", "priority": "critical"})
                actions.append({"action": "Surprise deliverable", "channel": "deliverable", "priority": "critical"})
            elif risk == ChurnRisk.HIGH:
                actions.append({"action": "Account manager check-in", "channel": "phone", "priority": "high"})
                actions.append({"action": "Results recap", "channel": "email", "priority": "high"})
            elif risk == ChurnRisk.MEDIUM:
                actions.append({"action": "Content planning session", "channel": "calendly", "priority": "medium"})
        return actions

    # ── Expansion Revenue ──

    def identify_expansion_opportunities(self) -> list[dict[str, Any]]:
        opportunities: list[dict[str, Any]] = []
        for c in self.customers.values():
            if c.status != CustomerStatus.ACTIVE or c.churn_risk in (ChurnRisk.HIGH, ChurnRisk.CRITICAL):
                continue
            if c.brand == "cutmv":
                if c.plan == "starter" and c.videos_processed_30d >= 8:
                    opportunities.append({
                        "customer_id": c.id, "name": c.name, "type": "plan_upgrade",
                        "from": "starter ($19)", "to": "pro ($49)",
                        "reason": f"{c.videos_processed_30d} videos/month on Starter",
                        "potential_mrr_increase": 30,
                    })
                if c.plan == "pro" and c.videos_processed_30d >= 20:
                    opportunities.append({
                        "customer_id": c.id, "name": c.name, "type": "plan_upgrade",
                        "from": "pro ($49)", "to": "agency ($99)",
                        "reason": f"{c.videos_processed_30d} videos/month hitting Pro limits",
                        "potential_mrr_increase": 50,
                    })
                if c.videos_processed_30d >= 5 and c.nps_score and c.nps_score >= 8:
                    opportunities.append({
                        "customer_id": c.id, "name": c.name, "type": "cross_sell",
                        "from": f"CUTMV {c.plan}", "to": "Full Digital creative services",
                        "reason": f"High engagement (NPS {c.nps_score})",
                        "potential_mrr_increase": 5000,
                    })
            elif c.brand == "fulldigital":
                if c.months_active >= 2 and c.churn_risk == ChurnRisk.LOW:
                    opportunities.append({
                        "customer_id": c.id, "name": c.name, "type": "cross_sell",
                        "from": "Full Digital retainer", "to": "CUTMV Agency ($99/mo)",
                        "reason": "Established FD client — CUTMV complements pipeline",
                        "potential_mrr_increase": 99,
                    })
                if c.months_active >= 1 and c.mrr < 3000 and c.nps_score and c.nps_score >= 7:
                    opportunities.append({
                        "customer_id": c.id, "name": c.name, "type": "upsell",
                        "from": f"${c.mrr}/mo", "to": "Full retainer $5,000+/mo",
                        "reason": f"Happy client (NPS {c.nps_score}), lightweight package",
                        "potential_mrr_increase": 5000 - c.mrr,
                    })

        return sorted(opportunities, key=lambda x: x["potential_mrr_increase"], reverse=True)

    # ── Max CAC Calculation ──

    def calculate_max_cac(self, brand: str) -> dict[str, Any]:
        active = [c for c in self.customers.values() if c.brand == brand and c.status == CustomerStatus.ACTIVE]
        if not active:
            return {"error": "No active customers", "recommended_max_cac": 0}

        ltvs = [self.calculate_ltv(c.id) for c in active]
        avg_ltv = sum(l["risk_adjusted_ltv"] for l in ltvs) / len(ltvs)
        avg_mrr = sum(c.mrr for c in active) / len(active)

        max_cac_3to1 = avg_ltv / 3
        max_cac_3mo_payback = avg_mrr * 3
        recommended = min(max_cac_3to1, max_cac_3mo_payback)

        return {
            "brand": brand,
            "avg_risk_adjusted_ltv": round(avg_ltv, 2),
            "avg_mrr": round(avg_mrr, 2),
            "max_cac_3to1_ratio": round(max_cac_3to1, 2),
            "max_cac_3mo_payback": round(max_cac_3mo_payback, 2),
            "recommended_max_cac": round(recommended, 2),
            "active_customers": len(active),
        }
