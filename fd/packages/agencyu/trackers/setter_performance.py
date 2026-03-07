"""Setter Performance Tracker — Weighted scoring, leaderboards, and alerts.

Full Digital LLC — Appointment Setter Analytics.
Tracks daily/weekly/monthly metrics for DM appointment setters.
Feeds into brain.py for setter allocation decisions.

Metrics:
- DMs sent / conversations started
- Qualification rate, book rate, show rate, close rate
- Revenue attributed, response time, EOD compliance
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import StrEnum
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.trackers.setter_performance")


class SetterStatus(StrEnum):
    ACTIVE = "active"
    TRAINING = "training"
    ON_LEAVE = "on_leave"
    TERMINATED = "terminated"


@dataclass
class DailySetterMetrics:
    """One day of setter activity."""

    setter_id: str
    date: date
    brand: str
    dms_sent: int = 0
    conversations_started: int = 0
    follow_ups_sent: int = 0
    leads_qualified: int = 0
    leads_disqualified: int = 0
    appointments_booked: int = 0
    appointments_showed: int = 0
    appointments_no_show: int = 0
    deals_closed: int = 0
    revenue_attributed: float = 0.0
    avg_response_time_minutes: float = 0.0
    eod_form_submitted: bool = False
    notes: str = ""

    @property
    def qualification_rate(self) -> float:
        total = self.leads_qualified + self.leads_disqualified
        return (self.leads_qualified / total * 100) if total > 0 else 0.0

    @property
    def book_rate(self) -> float:
        return (self.appointments_booked / self.conversations_started * 100) if self.conversations_started > 0 else 0.0

    @property
    def show_rate(self) -> float:
        total = self.appointments_showed + self.appointments_no_show
        return (self.appointments_showed / total * 100) if total > 0 else 0.0

    @property
    def close_rate(self) -> float:
        return (self.deals_closed / self.appointments_showed * 100) if self.appointments_showed > 0 else 0.0


@dataclass
class Setter:
    """An appointment setter profile."""

    id: str
    name: str
    brand: str
    status: SetterStatus = SetterStatus.ACTIVE
    start_date: date = field(default_factory=date.today)
    daily_metrics: list[DailySetterMetrics] = field(default_factory=list)
    target_dms_per_day: int = 30
    target_book_rate: float = 15.0
    target_show_rate: float = 70.0
    target_close_rate: float = 25.0
    target_response_time: float = 5.0

    def add_daily_metrics(self, metrics: DailySetterMetrics) -> None:
        self.daily_metrics.append(metrics)

    def get_period_metrics(self, days: int = 7) -> dict[str, Any]:
        cutoff = date.today() - timedelta(days=days)
        recent = [m for m in self.daily_metrics if m.date >= cutoff]
        if not recent:
            return {"period_days": days, "data_days": 0, "no_data": True}

        total_dms = sum(m.dms_sent for m in recent)
        total_convos = sum(m.conversations_started for m in recent)
        total_booked = sum(m.appointments_booked for m in recent)
        total_showed = sum(m.appointments_showed for m in recent)
        total_no_show = sum(m.appointments_no_show for m in recent)
        total_closed = sum(m.deals_closed for m in recent)
        total_revenue = sum(m.revenue_attributed for m in recent)
        eod_submitted = sum(1 for m in recent if m.eod_form_submitted)

        return {
            "period_days": days,
            "data_days": len(recent),
            "total_dms_sent": total_dms,
            "total_conversations": total_convos,
            "total_qualified": sum(m.leads_qualified for m in recent),
            "total_booked": total_booked,
            "total_showed": total_showed,
            "total_no_show": total_no_show,
            "total_closed": total_closed,
            "total_revenue": round(total_revenue, 2),
            "avg_dms_per_day": round(total_dms / len(recent), 1),
            "book_rate": round(total_booked / total_convos * 100, 1) if total_convos > 0 else 0,
            "show_rate": round(total_showed / (total_showed + total_no_show) * 100, 1) if (total_showed + total_no_show) > 0 else 0,
            "close_rate": round(total_closed / total_showed * 100, 1) if total_showed > 0 else 0,
            "avg_response_time": round(sum(m.avg_response_time_minutes for m in recent) / len(recent), 1),
            "eod_compliance": round(eod_submitted / len(recent) * 100, 1),
            "revenue_per_dm": round(total_revenue / total_dms, 2) if total_dms > 0 else 0,
        }


class SetterPerformanceTracker:
    """Central tracker for all appointment setters."""

    def __init__(self) -> None:
        self.setters: dict[str, Setter] = {}

    def add_setter(self, setter: Setter) -> None:
        self.setters[setter.id] = setter

    def log_daily_metrics(self, setter_id: str, metrics: DailySetterMetrics) -> None:
        if setter_id in self.setters:
            self.setters[setter_id].add_daily_metrics(metrics)

    # ── Performance Scoring ──

    def score_setter(self, setter_id: str, period_days: int = 30) -> dict[str, Any]:
        """Generate a 0-100 performance score weighted across key metrics."""
        setter = self.setters.get(setter_id)
        if not setter:
            return {"error": "Setter not found"}

        metrics = setter.get_period_metrics(period_days)
        if metrics.get("no_data"):
            return {"error": "No data available", "score": 0}

        weights = {
            "volume": 0.20,
            "book_rate": 0.25,
            "show_rate": 0.15,
            "close_rate": 0.20,
            "response_time": 0.10,
            "compliance": 0.10,
        }

        scores: dict[str, float] = {}
        scores["volume"] = min(metrics["avg_dms_per_day"] / setter.target_dms_per_day * 100, 100)
        scores["book_rate"] = min(metrics["book_rate"] / setter.target_book_rate * 100, 100)
        scores["show_rate"] = min(metrics["show_rate"] / setter.target_show_rate * 100, 100)
        scores["close_rate"] = min(metrics["close_rate"] / setter.target_close_rate * 100, 100)

        if metrics["avg_response_time"] <= setter.target_response_time:
            scores["response_time"] = 100
        else:
            scores["response_time"] = max(0, 100 - (metrics["avg_response_time"] - setter.target_response_time) * 10)

        scores["compliance"] = metrics["eod_compliance"]

        total_score = sum(scores[k] * weights[k] for k in weights)

        return {
            "setter_id": setter_id,
            "setter_name": setter.name,
            "period_days": period_days,
            "overall_score": round(total_score, 1),
            "grade": self._score_to_grade(total_score),
            "component_scores": {k: round(v, 1) for k, v in scores.items()},
            "metrics": metrics,
            "recommendations": self._generate_recommendations(scores, metrics, setter),
        }

    def _score_to_grade(self, score: float) -> str:
        if score >= 90:
            return "A"
        if score >= 80:
            return "B"
        if score >= 70:
            return "C"
        if score >= 60:
            return "D"
        return "F"

    def _generate_recommendations(
        self, scores: dict[str, float], metrics: dict[str, Any], setter: Setter,
    ) -> list[str]:
        recs: list[str] = []
        if scores["volume"] < 70:
            recs.append(f"DM volume low ({metrics['avg_dms_per_day']}/day vs {setter.target_dms_per_day} target)")
        if scores["book_rate"] < 70:
            recs.append(f"Booking rate {metrics['book_rate']}% (target: {setter.target_book_rate}%). Review DM scripts.")
        if scores["show_rate"] < 70:
            recs.append(f"Show rate {metrics['show_rate']}% (target: {setter.target_show_rate}%). Add pre-call nurture.")
        if scores["close_rate"] < 70:
            recs.append(f"Close rate {metrics['close_rate']}% (target: {setter.target_close_rate}%). Review objection handling.")
        if scores["response_time"] < 70:
            recs.append(f"Response time {metrics['avg_response_time']}min (target: {setter.target_response_time}min)")
        if scores["compliance"] < 80:
            recs.append(f"EOD compliance {metrics['eod_compliance']}%. Make non-negotiable.")
        if not recs:
            recs.append("Performance strong across all metrics. Consider increasing lead volume.")
        return recs

    # ── Leaderboard ──

    def generate_leaderboard(self, brand: str | None = None, period_days: int = 30) -> list[dict[str, Any]]:
        leaderboard: list[dict[str, Any]] = []
        for setter_id, setter in self.setters.items():
            if brand and setter.brand != brand:
                continue
            if setter.status != SetterStatus.ACTIVE:
                continue
            score = self.score_setter(setter_id, period_days)
            if "error" not in score:
                leaderboard.append(score)

        leaderboard.sort(key=lambda x: x["overall_score"], reverse=True)
        for i, entry in enumerate(leaderboard):
            entry["rank"] = i + 1
        return leaderboard

    # ── Alerts ──

    def check_alerts(self) -> list[dict[str, Any]]:
        alerts: list[dict[str, Any]] = []
        for setter_id, setter in self.setters.items():
            if setter.status != SetterStatus.ACTIVE:
                continue

            recent = [m for m in setter.daily_metrics if m.date >= date.today() - timedelta(days=2)]
            missing_eod = [m for m in recent if not m.eod_form_submitted]
            if len(missing_eod) >= 2:
                alerts.append({
                    "type": "missing_eod", "severity": "warning",
                    "setter_id": setter_id, "setter_name": setter.name,
                    "message": f"{setter.name} has not submitted EOD form in {len(missing_eod)} days.",
                })

            week = setter.get_period_metrics(7)
            month = setter.get_period_metrics(30)
            if not week.get("no_data") and not month.get("no_data"):
                if week["book_rate"] < month["book_rate"] * 0.5 and month["book_rate"] > 0:
                    alerts.append({
                        "type": "performance_drop", "severity": "critical",
                        "setter_id": setter_id, "setter_name": setter.name,
                        "message": f"{setter.name}'s book rate dropped from {month['book_rate']}% (30d) to {week['book_rate']}% (7d).",
                    })

            last_3 = [m for m in setter.daily_metrics if m.date >= date.today() - timedelta(days=3)]
            if last_3 and all(m.appointments_booked == 0 for m in last_3):
                alerts.append({
                    "type": "zero_bookings", "severity": "warning",
                    "setter_id": setter_id, "setter_name": setter.name,
                    "message": f"{setter.name} has booked 0 appointments in the last 3 days.",
                })

        return alerts
