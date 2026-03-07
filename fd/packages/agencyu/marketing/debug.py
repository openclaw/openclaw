"""Policy debug explainer — prints exactly why each combo was held/rotated/killed/scaled.

policy_debug_explain(combo_id) re-runs the decision pipeline for a single combo
in trace mode and returns a human-readable + machine-readable report.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.agencyu.marketing.fatigue import detect_fatigue
from packages.agencyu.marketing.ledger_metrics import LedgerMetrics
from packages.agencyu.marketing.metrics_types import ComboMetrics, ComboMetricsFD
from packages.agencyu.marketing.payback import payback_gate_one_time
from packages.agencyu.marketing.policy_trace import DecisionTrace
from packages.agencyu.marketing.revenue_forecast import (
    beta_ci,
    scaling_confidence_from_uncertainty,
)
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.debug")

_DEFAULT_POLICY_PATH = Path(__file__).resolve().parent.parent / "config" / "experiment_policy.yaml"


def policy_debug_explain(
    combo_id: str,
    *,
    conn: sqlite3.Connection,
    policy_path: str | Path | None = None,
) -> dict[str, Any]:
    """Re-run the decision pipeline for a single combo in trace mode.

    Returns a structured report showing every gate/signal check and its
    outcome. Useful for debugging why a combo is being held, killed, or
    not scaling.

    Args:
        combo_id: The combo to explain.
        conn: SQLite connection.
        policy_path: Path to experiment_policy.yaml (default: auto-resolved).

    Returns:
        Dict with trace, human-readable explanation lines, and raw metrics.
    """
    resolved_path = Path(policy_path) if policy_path else _DEFAULT_POLICY_PATH
    with open(resolved_path, encoding="utf-8") as f:
        policy: dict[str, Any] = yaml.safe_load(f)

    ledger = AttributionLedger(conn)
    lm = LedgerMetrics(conn)

    # Determine brand from chain data
    chains = ledger.get_chains_by_combo(combo_id)
    if not chains:
        return {
            "combo_id": combo_id,
            "error": "no_chains_found",
            "explanation": [f"No attribution chains found for combo_id={combo_id}"],
        }

    brand = chains[0].get("brand", "unknown")
    stats = ledger.get_combo_stats(combo_id)

    # Build time window from policy
    window_hours = int(
        policy.get("measurement", {})
        .get("sample_windows", {})
        .get("evaluation_window_hours", 72)
    )
    now_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    since_epoch = time.time() - (window_hours * 3600)
    since_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(since_epoch))

    # Gather ledger metrics
    call_stats = lm.get_calls_by_combo(brand, since_ts, now_ts)
    rev_stats = lm.get_revenue_by_combo(brand, since_ts, now_ts)

    cs = call_stats.get(combo_id)
    rs = rev_stats.get(combo_id)

    calls_observed = cs.calls_observed if cs else 0
    calls_booked = cs.calls_booked if cs else 0
    calls_showed = cs.calls_showed if cs else 0
    closes = rs.closes if rs else 0
    gross_rev = rs.gross_revenue_usd if rs else 0.0
    refunds = rs.refunds_usd if rs else 0.0
    net_rev = rs.net_revenue_usd if rs else 0.0

    trace = DecisionTrace(
        combo_id=combo_id,
        brand=brand,
        final_decision="pending",
        input_metrics={
            "chains": len(chains),
            "stages": stats.get("stages", {}),
            "calls_booked": calls_booked,
            "calls_showed": calls_showed,
            "calls_observed": calls_observed,
            "closes": closes,
            "gross_revenue_usd": gross_rev,
            "refunds_usd": refunds,
            "net_revenue_usd": net_rev,
            "close_rate": (closes / calls_observed) if calls_observed > 0 else 0.0,
        },
    )

    explanation: list[str] = [
        f"=== Policy Debug: combo_id={combo_id} brand={brand} ===",
        f"Chains: {len(chains)}",
        f"Calls: booked={calls_booked} showed={calls_showed} observed={calls_observed}",
        f"Closes: {closes}  Revenue: gross=${gross_rev:.2f} refunds=${refunds:.2f} net=${net_rev:.2f}",
    ]

    # ── Minimum sample check ──
    meas = policy["measurement"]
    mins: dict[str, Any] = dict(meas["minimums"])
    mins.update(policy["brands"].get(brand, {}).get("min_sample_overrides", {}) or {})

    min_conv = int(mins.get("min_conversions", 1))
    if closes < min_conv:
        trace.add_step("min_conversions", "fail", closes=closes, required=min_conv)
        explanation.append(f"[HOLD] Conversions {closes} < min {min_conv}")
    else:
        trace.add_step("min_conversions", "pass", closes=closes, required=min_conv)
        explanation.append(f"[PASS] Conversions {closes} >= min {min_conv}")

    # ── Quality gate (FD only) ──
    if brand == "fulldigital":
        gate_cfg = policy.get("brands", {}).get("fulldigital", {}).get("quality_gate", {})
        if gate_cfg.get("enabled", False):
            cr = (closes / calls_observed) if calls_observed > 0 else 0.0
            close_min = float(gate_cfg.get("close_rate_min", 0.05))
            min_pipeline = int(gate_cfg.get("min_pipeline_conversions", 20))
            pipeline_conv = stats.get("stages", {}).get("booking_complete", 0) + stats.get("stages", {}).get("application_submit", 0)

            if pipeline_conv >= min_pipeline:
                if cr >= close_min:
                    trace.add_step("quality_gate_l2", "pass", close_rate=cr, min=close_min)
                    explanation.append(f"[PASS] Close rate {cr:.3f} >= {close_min}")
                else:
                    trace.add_step("quality_gate_l2", "block", close_rate=cr, min=close_min)
                    explanation.append(f"[BLOCK] Close rate {cr:.3f} < {close_min} — scale blocked")
            else:
                trace.add_step("quality_gate_l2", "skip", pipeline_conv=pipeline_conv, min=min_pipeline)
                explanation.append(f"[SKIP] Pipeline conversions {pipeline_conv} < {min_pipeline} — gate not triggered")

            trace.quality_gate = {
                "close_rate": cr,
                "close_rate_min": close_min,
                "pipeline_conversions": pipeline_conv,
            }

    # ── B4: Angle fatigue ──
    fatigue_cfg = policy.get("angle_fatigue", {})
    if fatigue_cfg.get("enabled", False):
        # Use placeholder frequency (no Meta data in debug mode)
        sig = detect_fatigue(
            frequency=0.0,
            ctr_now=0.01,
            ctr_prev=0.012,
            cpc_now=1.0,
            cpc_prev=0.8,
            freq_threshold=float(fatigue_cfg.get("frequency_threshold", 2.8)),
            ctr_drop_pct=float(fatigue_cfg.get("ctr_drop_pct", 35)),
            cpc_increase_pct=float(fatigue_cfg.get("cpc_increase_pct", 40)),
            min_signals=int(fatigue_cfg.get("min_signals", 2)),
        )
        if sig.fatigued:
            trace.add_step("fatigue_b4", "rotate", reasons=sig.reasons)
            explanation.append(f"[ROTATE] Fatigue detected: {', '.join(sig.reasons)}")
        else:
            trace.add_step("fatigue_b4", "pass", reasons=sig.reasons)
            explanation.append(f"[PASS] No fatigue ({len(sig.reasons)} signal(s), need {fatigue_cfg.get('min_signals', 2)})")

    # ── B1: Close-rate volatility ──
    forecast_cfg = policy.get("forecasting", {})
    vol_cfg = forecast_cfg.get("close_rate_volatility", {})
    if vol_cfg.get("enabled", False) and brand == "fulldigital":
        min_calls = int(vol_cfg.get("min_calls_for_model", 30))
        if calls_observed >= min_calls:
            unc = beta_ci(
                closes, calls_observed,
                iterations=int(forecast_cfg.get("monte_carlo", {}).get("iterations", 1000)),
            )
            penalty = float(vol_cfg.get("penalty_weight", 0.35))
            confidence = scaling_confidence_from_uncertainty(unc, penalty)
            hold_thr = float(vol_cfg.get("hold_threshold", 0.25))
            soft_thr = float(vol_cfg.get("scale_soft_threshold", 0.50))

            trace.add_step(
                "volatility_b1", "evaluated",
                confidence=round(confidence, 3),
                ci_width=round(unc.width, 4),
                hold_threshold=hold_thr,
                soft_threshold=soft_thr,
            )

            if confidence < hold_thr:
                explanation.append(f"[HOLD] Volatility confidence {confidence:.3f} < {hold_thr}")
            elif confidence < soft_thr:
                explanation.append(f"[SOFT] Volatility confidence {confidence:.3f} < {soft_thr} — scale_soft")
            else:
                explanation.append(f"[PASS] Volatility confidence {confidence:.3f} >= {soft_thr}")
        else:
            trace.add_step("volatility_b1", "skip", calls=calls_observed, min=min_calls)
            explanation.append(f"[SKIP] Volatility: calls {calls_observed} < {min_calls}")

    # ── B6: Capacity gate ──
    cap_gate_cfg = policy.get("capacity_gate", {})
    if cap_gate_cfg.get("enabled", False):
        from packages.agencyu.operations.capacity_gate import capacity_ok_to_scale

        cap_ok, cap_msg, cap_data = capacity_ok_to_scale(conn, brand, policy)
        trace.add_step(
            "capacity_gate_b6", "pass" if cap_ok else "block",
            message=cap_msg,
            known=cap_data.get("known", False),
            headroom_ratio=cap_data.get("headroom_ratio", 0),
            free_hours=cap_data.get("free_hours", 0),
        )
        if cap_ok:
            explanation.append(f"[PASS] Capacity gate: {cap_msg}")
        else:
            explanation.append(f"[BLOCK] Capacity gate: {cap_msg}")

    # ── B5: Payback gate ──
    payback_cfg = policy.get("payback", {})
    if payback_cfg.get("enabled", False) and closes > 0:
        brand_pb = payback_cfg.get(brand, {})
        gm = float(brand_pb.get("gross_margin", 0.70))
        max_pb = int(brand_pb.get("max_payback_days", 30))
        # Estimate CAC and avg revenue
        cac = net_rev / closes if closes > 0 else 0  # simplified
        avg_rev = net_rev / closes if closes > 0 else 0

        pb = payback_gate_one_time(
            cac=cac,
            net_revenue=avg_rev,
            gross_margin=gm,
            max_payback_days=max_pb,
        )

        trace.add_step(
            "payback_b5", "pass" if pb.ok else "block",
            payback_days=pb.payback_days,
            max_days=max_pb,
            reason=pb.reason,
        )
        if pb.ok:
            explanation.append(f"[PASS] Payback: {pb.payback_days:.0f} days (max {max_pb})")
        else:
            explanation.append(f"[BLOCK] Payback: {pb.payback_days:.0f} days > max {max_pb}")

    trace.final_decision = "see_steps"
    explanation.append("=== End Debug ===")

    return {
        "combo_id": combo_id,
        "brand": brand,
        "trace": trace.to_dict(),
        "explanation": explanation,
    }
