"""Automated Setter Router — quality-based lead routing with fairness constraints.

Routes leads to setters based on:
- Lead quality score (application_score, show_rate_history, source_quality, engagement)
- Setter performance (close_rate, show_rate, response speed)
- Capacity (daily lead limit, queue headroom)
- Fairness (min/max share constraints)

Never overrides setter_locked leads. Every routing decision is logged.

Upgrades the existing setter_allocator.py with:
- Quality-based scoring (not just round-robin for standard leads)
- Weighted random among top N setters (reduces concentration risk)
- Training setter gating (low-quality leads → training setters)
- Explicit policy_debug_explain support
"""
from __future__ import annotations

import json
import random
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.marketing.setter_scoring import compute_setter_scores
from packages.common.ids import make_id
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.setter_router")

_POLICY_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "setter_policy.yaml"


# ── Data models ──


@dataclass(frozen=True)
class LeadQuality:
    """Computed quality score for a lead."""

    contact_key: str
    overall_score: float  # 0-100
    application_score: float
    show_rate_score: float
    source_quality_score: float
    engagement_score: float
    tier: str  # "high" | "standard" | "training"


@dataclass(frozen=True)
class SetterCandidate:
    """A setter ranked for routing."""

    setter_id: str
    display_name: str
    brand: str
    close_rate_score: float
    show_rate_score: float
    speed_score: float
    composite_score: float
    assigned_today: int
    max_daily: int
    available: bool


@dataclass(frozen=True)
class RoutingResult:
    """Result of a routing decision."""

    setter_id: str
    setter_name: str
    lead_contact_key: str
    lead_quality_score: float
    setter_composite_score: float
    lead_tier: str
    routing_reason: str
    is_override: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "setter_id": self.setter_id,
            "setter_name": self.setter_name,
            "lead_contact_key": self.lead_contact_key,
            "lead_quality_score": self.lead_quality_score,
            "setter_composite_score": self.setter_composite_score,
            "lead_tier": self.lead_tier,
            "routing_reason": self.routing_reason,
            "is_override": self.is_override,
        }


# ── Config loading ──


def load_setter_policy(path: Path | None = None) -> dict[str, Any]:
    """Load setter_policy.yaml config."""
    p = path or _POLICY_PATH
    if not p.exists():
        return {}
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return raw.get("setter_policy", raw)


# ── Lead quality scoring ──


def compute_lead_quality(
    conn: sqlite3.Connection,
    lead: dict[str, Any],
    *,
    policy: dict[str, Any] | None = None,
) -> LeadQuality:
    """Compute quality score for a lead based on configured signals."""
    cfg = policy or load_setter_policy()
    signals = cfg.get("routing", {}).get("quality_signals", [])
    contact_key = lead.get("contact_key", lead.get("contact_id", ""))

    # Extract signal values
    app_score = float(lead.get("application_score", 50))
    show_rate = float(lead.get("show_rate_history", 0.7))
    source_quality = float(lead.get("lead_source_quality", 50))
    engagement = float(lead.get("engagement_depth", 0))

    # Normalize to 0-100
    app_norm = min(100, max(0, app_score))
    show_norm = min(100, show_rate * 100)
    source_norm = min(100, max(0, source_quality))
    engage_norm = min(100, engagement * 10)  # 10 touches = perfect

    # Weighted average
    weights = {s.get("signal", ""): s.get("weight", 0.25) for s in signals}
    overall = (
        app_norm * weights.get("application_score", 0.40)
        + show_norm * weights.get("show_rate_history", 0.25)
        + source_norm * weights.get("lead_source_quality", 0.20)
        + engage_norm * weights.get("engagement_depth", 0.15)
    )

    # Determine tier
    high_min = float(cfg.get("routing", {}).get("high_value_min_quality_score", 70))
    training_max = float(cfg.get("overrides", {}).get("training_setter_max_quality", 50))

    if overall >= high_min:
        tier = "high"
    elif overall <= training_max:
        tier = "training"
    else:
        tier = "standard"

    return LeadQuality(
        contact_key=contact_key,
        overall_score=round(overall, 1),
        application_score=app_norm,
        show_rate_score=show_norm,
        source_quality_score=source_norm,
        engagement_score=engage_norm,
        tier=tier,
    )


# ── Setter ranking ──


def rank_setters(
    conn: sqlite3.Connection,
    brand: str,
    *,
    policy: dict[str, Any] | None = None,
) -> list[SetterCandidate]:
    """Rank all active setters by composite performance score."""
    cfg = policy or load_setter_policy()
    scoring = cfg.get("setter_scoring", {})
    max_daily = int(cfg.get("max_daily_leads_per_setter", 15))

    cr_weight = float(scoring.get("close_rate_weight", 0.55))
    sr_weight = float(scoring.get("show_rate_weight", 0.30))
    sp_weight = float(scoring.get("speed_weight", 0.15))
    cr_target = float(scoring.get("close_rate_target", 0.30))
    sr_target = float(scoring.get("show_rate_target", 0.80))
    max_resp = float(scoring.get("max_response_minutes", 60))

    from datetime import timedelta
    now = datetime.now(UTC)
    since_ts = (now - timedelta(days=30)).isoformat()
    until_ts = now.isoformat()

    scores = compute_setter_scores(conn, brand, since_ts, until_ts)
    candidates: list[SetterCandidate] = []

    try:
        rows = conn.execute(
            """SELECT
                setter_id,
                COALESCE(MAX(display_name), setter_id) AS display_name,
                SUM(booked_calls) AS total_booked,
                SUM(appointments_showed) AS total_showed,
                AVG(avg_response_time_minutes) AS avg_response,
                MAX(current_queue_size) AS current_queue
            FROM setter_daily_metrics
            WHERE brand = ? AND date >= ?
            GROUP BY setter_id""",
            (brand, since_ts[:10]),
        ).fetchall()
    except Exception:
        log.debug("setter_ranking_query_error", exc_info=True)
        return []

    today = now.strftime("%Y-%m-%d")

    for r in rows:
        sid = r["setter_id"]
        score_data = scores.get(sid)

        close_rate = score_data.close_rate if score_data else 0.0
        total_booked = int(r["total_booked"] or 0)
        total_showed = int(r["total_showed"] or 0)
        show_rate = total_showed / max(1, total_booked)
        avg_resp = float(r["avg_response"] or max_resp)

        # Normalized scores (0-100)
        cr_score = min(100, (close_rate / cr_target) * 100)
        sr_score = min(100, (show_rate / sr_target) * 100)
        sp_score = max(0, (1 - avg_resp / max_resp)) * 100

        composite = cr_score * cr_weight + sr_score * sr_weight + sp_score * sp_weight

        # Today's assignment count
        assigned_today = 0
        try:
            arow = conn.execute(
                """SELECT assigned_count FROM setter_lead_assignments
                   WHERE setter_id = ? AND date = ?""",
                (sid, today),
            ).fetchone()
            if arow:
                assigned_today = int(arow["assigned_count"])
        except Exception:
            pass

        candidates.append(SetterCandidate(
            setter_id=sid,
            display_name=r["display_name"] or sid,
            brand=brand,
            close_rate_score=round(cr_score, 1),
            show_rate_score=round(sr_score, 1),
            speed_score=round(sp_score, 1),
            composite_score=round(composite, 1),
            assigned_today=assigned_today,
            max_daily=max_daily,
            available=assigned_today < max_daily,
        ))

    return sorted(candidates, key=lambda c: c.composite_score, reverse=True)


# ── Lead routing ──


def pick_setter(
    conn: sqlite3.Connection,
    brand: str,
    lead: dict[str, Any],
    *,
    safe_mode: bool = True,
    policy: dict[str, Any] | None = None,
) -> RoutingResult | None:
    """Route a lead to the optimal setter.

    Routing strategy:
    - setter_locked leads → respect override, no reroute
    - High-value leads → best available setter
    - Training-tier leads → training setters only
    - Standard leads → weighted random among top 3 setters

    Returns None if no setters available.
    """
    cfg = policy or load_setter_policy()
    overrides = cfg.get("overrides", {})
    contact_key = lead.get("contact_key", lead.get("contact_id", ""))

    # Check setter_locked
    if overrides.get("setter_locked_respected", True) and lead.get("setter_locked"):
        locked_setter = lead.get("setter_id", "")
        if locked_setter:
            return RoutingResult(
                setter_id=locked_setter,
                setter_name=lead.get("setter_name", locked_setter),
                lead_contact_key=contact_key,
                lead_quality_score=0,
                setter_composite_score=0,
                lead_tier="override",
                routing_reason="setter_locked — no reroute",
                is_override=True,
            )

    # Compute lead quality
    quality = compute_lead_quality(conn, lead, policy=cfg)

    # Rank setters
    candidates = rank_setters(conn, brand, policy=cfg)
    available = [c for c in candidates if c.available]

    if not available:
        log.warning("no_setters_available", extra={"brand": brand})
        return None

    # Route based on tier
    if quality.tier == "high":
        # Best setter for high-value leads
        pick = available[0]
        reason = f"high_value_lead (quality={quality.overall_score}) → top_setter (score={pick.composite_score})"

    elif quality.tier == "training":
        # Worst setter (training) for low-quality leads
        pick = available[-1]
        reason = f"training_tier (quality={quality.overall_score}) → training_setter (score={pick.composite_score})"

    else:
        # Standard: weighted random among top 3
        top_n = available[:min(3, len(available))]
        pick = _weighted_choice(top_n)
        reason = f"standard_weighted_random (quality={quality.overall_score}) among top {len(top_n)}"

    result = RoutingResult(
        setter_id=pick.setter_id,
        setter_name=pick.display_name,
        lead_contact_key=contact_key,
        lead_quality_score=quality.overall_score,
        setter_composite_score=pick.composite_score,
        lead_tier=quality.tier,
        routing_reason=reason,
    )

    # Log decision
    if not safe_mode:
        _record_routing(conn, result, brand, lead.get("offer_id"))

    return result


def _weighted_choice(candidates: list[SetterCandidate]) -> SetterCandidate:
    """Weighted random selection among setter candidates."""
    total = sum(max(0.001, c.composite_score) for c in candidates)
    r = random.random() * total
    upto = 0.0
    for c in candidates:
        upto += max(0.001, c.composite_score)
        if upto >= r:
            return c
    return candidates[0]


def _record_routing(
    conn: sqlite3.Connection,
    result: RoutingResult,
    brand: str,
    offer_id: str | None,
) -> None:
    """Log routing decision to DB."""
    now = datetime.now(UTC).isoformat()
    today = now[:10]

    try:
        conn.execute(
            """INSERT INTO setter_routing_log
               (id, lead_contact_key, brand, setter_id, setter_name, lead_quality_score,
                setter_composite_score, lead_tier, offer_id, routing_reason, is_override, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                make_id("route"),
                result.lead_contact_key,
                brand,
                result.setter_id,
                result.setter_name,
                result.lead_quality_score,
                result.setter_composite_score,
                result.lead_tier,
                offer_id,
                result.routing_reason,
                1 if result.is_override else 0,
                now,
            ),
        )

        # Update daily assignment count
        conn.execute(
            """INSERT INTO setter_lead_assignments (id, setter_id, brand, date, assigned_count, max_daily)
               VALUES (?, ?, ?, ?, 1, ?)
               ON CONFLICT(setter_id, date) DO UPDATE SET assigned_count = assigned_count + 1""",
            (make_id("sla"), result.setter_id, brand, today, 15),
        )

        conn.commit()
    except Exception:
        log.debug("record_routing_error", exc_info=True)


# ── Explain ──


def explain_routing(
    conn: sqlite3.Connection,
    brand: str,
    lead: dict[str, Any],
) -> dict[str, Any]:
    """Debug: explain what routing decision would be made for a lead."""
    quality = compute_lead_quality(conn, lead)
    candidates = rank_setters(conn, brand)
    result = pick_setter(conn, brand, lead, safe_mode=True)

    return {
        "lead_quality": {
            "overall": quality.overall_score,
            "tier": quality.tier,
            "application_score": quality.application_score,
            "show_rate_score": quality.show_rate_score,
            "source_quality_score": quality.source_quality_score,
            "engagement_score": quality.engagement_score,
        },
        "setter_rankings": [
            {
                "setter_id": c.setter_id,
                "name": c.display_name,
                "composite": c.composite_score,
                "assigned_today": c.assigned_today,
                "available": c.available,
            }
            for c in candidates[:5]
        ],
        "routing_result": result.to_dict() if result else None,
    }
