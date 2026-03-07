"""Quality gate for Full Digital — blocks scaling junk-call winners.

Three-layer gate system:

Layer 1 — Pipeline Quality Minimum (pre-check):
  "Do we have enough real signal yet?"
  Must pass before any close-rate or show-rate evaluation.
  If not met, scale → hold.

Layer 2 — Close-Rate Gate:
  "Even if the combo books calls, don't scale if they don't close."
  close_rate = revenue_conversions / pipeline_conversions
  Blocks scale_budget when close rate is below threshold.
  Hard-fail escalation to pause when close rate is catastrophically low.

Layer 3 — Pipeline Integrity (Show Rate):
  "Some combos generate bookings but nobody shows up."
  show_rate = attended_calls / bookings
  Blocks scale_budget when show rate is below threshold.
  Catches clickbait angles and low-trust messaging.

This is a post-processor that runs after the core policy engine produces
hold/kill/scale/fatigue decisions. It only affects Full Digital combos
where the decision is scale_budget, downgrading them to hold (or pause).

Does NOT alter kill, hold, or fatigue decisions — only scale.

Configuration lives in experiment_policy.yaml under:
  brands.fulldigital.pipeline_quality_minimum
  brands.fulldigital.quality_gate
  brands.fulldigital.pipeline_integrity
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.marketing.metrics_types import ComboMetricsFD
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.quality_gate")


# ── Layer 1: Pipeline Quality Minimum ──


def passes_pipeline_quality_minimum(
    m: ComboMetricsFD,
    policy: dict[str, Any],
) -> tuple[bool, str | None]:
    """Check if a combo has enough pipeline signal to be judged.

    Returns:
        (passes, reason_if_not)
    """
    pqm_cfg = (
        policy.get("brands", {})
        .get("fulldigital", {})
        .get("pipeline_quality_minimum", {})
    )

    if not pqm_cfg.get("enabled", False):
        return True, None

    min_calls = int(pqm_cfg.get("min_calls_observed", 20))
    min_pipeline = int(pqm_cfg.get("min_pipeline_conversions", 15))
    min_spend = float(pqm_cfg.get("min_spend_before_quality_eval", 0))

    if m.calls_observed < min_calls:
        return False, f"calls_observed={m.calls_observed} < min={min_calls}"

    if m.pipeline_conversions < min_pipeline:
        return False, f"pipeline_conversions={m.pipeline_conversions} < min={min_pipeline}"

    if min_spend > 0 and m.spend_usd < min_spend:
        return False, f"spend_usd={m.spend_usd} < min={min_spend}"

    # Optional: lead score check
    if pqm_cfg.get("enabled_lead_score", False):
        min_score = float(pqm_cfg.get("min_avg_lead_score", 60))
        if m.avg_lead_score is not None and m.avg_lead_score < min_score:
            return False, f"avg_lead_score={m.avg_lead_score} < min={min_score}"

    # Optional: qualified rate check
    if pqm_cfg.get("enabled_qualified_rate", False):
        min_qr = float(pqm_cfg.get("min_qualified_rate", 0.35))
        if m.qualified_rate < min_qr:
            return False, f"qualified_rate={m.qualified_rate} < min={min_qr}"

    return True, None


# ── Layer 3: Pipeline Integrity (Show Rate) ──


def passes_pipeline_integrity(
    m: ComboMetricsFD,
    policy: dict[str, Any],
) -> tuple[bool, str | None]:
    """Check if a combo's show rate meets minimum threshold.

    show_rate = attended_calls / bookings
    Protects against low-trust messaging, clickbait angles, unqualified applicants.

    Returns:
        (passes, reason_if_not)
    """
    pi_cfg = (
        policy.get("brands", {})
        .get("fulldigital", {})
        .get("pipeline_integrity", {})
    )

    if not pi_cfg.get("enabled", False):
        return True, None

    min_bookings = int(pi_cfg.get("min_bookings_for_show_eval", 15))
    min_show_rate = float(pi_cfg.get("min_show_rate", 0.60))

    # Not enough bookings to evaluate show rate — pass through
    if m.bookings < min_bookings:
        return True, None

    if m.show_rate < min_show_rate:
        return False, (
            f"show_rate={m.show_rate:.2f} < min={min_show_rate} "
            f"(attended={m.attended_calls}, bookings={m.bookings})"
        )

    return True, None


# ── Combined Quality Gate ──


def apply_quality_gate(
    action: dict[str, Any],
    m: ComboMetricsFD,
    policy: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Apply Full Digital three-layer quality gate to a single action.

    Layer 1: Pipeline quality minimum — enough signal before judging.
    Layer 2: Close-rate gate — blocks junk-call winners.
    Layer 3: Pipeline integrity — blocks low-show-rate combos.

    Only affects scale_budget decisions. Kill/hold/fatigue pass through.

    Args:
        action: The policy engine's action dict (combo_id, decision, detail, etc.)
        m: ComboMetricsFD for this combo
        policy: Full experiment policy dict

    Returns:
        (possibly_modified_action, gate_block_record_or_None)
    """
    gate_cfg = (
        policy.get("brands", {})
        .get("fulldigital", {})
        .get("quality_gate", {})
    )

    if not gate_cfg.get("enabled", False):
        return action, None

    # Only gate scale decisions
    if action.get("decision") != "scale_budget":
        return action, None

    # ── Layer 1: Pipeline Quality Minimum ──
    pqm_passes, pqm_reason = passes_pipeline_quality_minimum(m, policy)
    if not pqm_passes:
        gated = dict(action)
        original_decision = action["decision"]
        hold_cfg = gate_cfg.get("hold_mode", {})
        cap_budget = float(hold_cfg.get("cap_daily_budget_usd", 10))

        gated["decision"] = "hold"
        gated["detail"] = {
            **action.get("detail", {}),
            "reason": "pipeline_quality_minimum_not_met",
            "pipeline_quality": {
                "passes": False,
                "block_reason": pqm_reason,
                "calls_observed": m.calls_observed,
                "pipeline_conversions": m.pipeline_conversions,
                "qualified_rate": m.qualified_rate,
                "avg_lead_score": m.avg_lead_score,
            },
            "cap_daily_budget_usd": cap_budget,
        }

        log.info(
            "pipeline_quality_minimum_block",
            extra={
                "combo_id": m.combo_id,
                "reason": pqm_reason,
                "original_decision": original_decision,
            },
        )

        return gated, _block_record(
            m, original_decision, "hold",
            gate_stage="pipeline_quality_minimum",
            gate_reason=pqm_reason,
        )

    # ── Layer 2: Close-Rate Gate ──
    close_result = _evaluate_close_rate_gate(action, m, gate_cfg)
    if close_result is not None:
        return close_result

    # ── Layer 3: Pipeline Integrity (Show Rate) ──
    pi_passes, pi_reason = passes_pipeline_integrity(m, policy)
    if not pi_passes:
        gated = dict(action)
        original_decision = action["decision"]
        hold_cfg = gate_cfg.get("hold_mode", {})
        cap_budget = float(hold_cfg.get("cap_daily_budget_usd", 10))

        gated["decision"] = "hold"
        gated["detail"] = {
            **action.get("detail", {}),
            "reason": "pipeline_integrity_low_show_rate",
            "pipeline_integrity": {
                "show_rate": m.show_rate,
                "attended_calls": m.attended_calls,
                "bookings": m.bookings,
                "block_reason": pi_reason,
            },
            "cap_daily_budget_usd": cap_budget,
        }

        log.info(
            "pipeline_integrity_block",
            extra={
                "combo_id": m.combo_id,
                "show_rate": m.show_rate,
                "attended_calls": m.attended_calls,
                "bookings": m.bookings,
                "original_decision": original_decision,
            },
        )

        return gated, _block_record(
            m, original_decision, "hold",
            gate_stage="pipeline_integrity",
            gate_reason=pi_reason,
        )

    # All layers pass — let it scale
    return action, None


# ── Close-Rate Gate internals ──


def _evaluate_close_rate_gate(
    action: dict[str, Any],
    m: ComboMetricsFD,
    gate_cfg: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Evaluate close-rate gate. Returns (gated_action, block_record) or None if passes."""
    min_pipeline = int(gate_cfg.get("min_pipeline_conversions", 20))
    close_min = float(gate_cfg.get("close_rate_min", 0.05))
    min_spend = float(gate_cfg.get("min_spend_usd", 0))

    # Not enough data to judge yet — pass through
    if m.pipeline_conversions < min_pipeline:
        return None
    if m.spend_usd < min_spend:
        return None

    # Close rate is acceptable — pass through
    if m.close_rate >= close_min:
        return None

    # ── Gate triggers: block scale ──
    original_decision = action["decision"]
    gated = dict(action)

    # Hard fail escalation: catastrophically low close rate → pause
    hard_fail_rate = float(gate_cfg.get("hard_fail_close_rate", 0.0))
    hard_fail_action = gate_cfg.get("hard_fail_action", "pause")
    if hard_fail_rate > 0 and m.close_rate <= hard_fail_rate:
        gated["decision"] = hard_fail_action
        gated["detail"] = {
            **action.get("detail", {}),
            "reason": "quality_gate_hard_fail",
            "quality_gate": _gate_detail(m, gate_cfg),
            "hard_fail_close_rate": hard_fail_rate,
        }

        log.info(
            "quality_gate_hard_fail",
            extra={
                "combo_id": m.combo_id,
                "close_rate": m.close_rate,
                "hard_fail_rate": hard_fail_rate,
                "original_decision": original_decision,
                "gated_decision": gated["decision"],
            },
        )

        return gated, _block_record(
            m, original_decision, gated["decision"],
            gate_stage="close_rate_hard_fail",
            gate_config={
                "hard_fail_close_rate": hard_fail_rate,
                "hard_fail_action": hard_fail_action,
            },
        )

    # Normal close-rate gate
    gate_decision = (gate_cfg.get("decision") or "block_scale").lower()
    hold_cfg = gate_cfg.get("hold_mode", {})
    hold_action = (hold_cfg.get("action") or "hold").lower()
    cap_budget = float(hold_cfg.get("cap_daily_budget_usd", 10))

    if gate_decision == "block_scale_and_kill":
        gated["decision"] = "pause"
        gated["detail"] = {
            **action.get("detail", {}),
            "reason": "quality_gate_close_rate_kill",
            "quality_gate": _gate_detail(m, gate_cfg),
        }
    else:
        gated["decision"] = hold_action
        gated["detail"] = {
            **action.get("detail", {}),
            "reason": "quality_gate_close_rate",
            "quality_gate": _gate_detail(m, gate_cfg),
            "cap_daily_budget_usd": cap_budget,
        }

    log.info(
        "quality_gate_triggered",
        extra={
            "combo_id": m.combo_id,
            "close_rate": m.close_rate,
            "pipeline_conversions": m.pipeline_conversions,
            "original_decision": original_decision,
            "gated_decision": gated["decision"],
        },
    )

    return gated, _block_record(
        m, original_decision, gated["decision"],
        gate_stage="close_rate",
        gate_config={
            "min_pipeline_conversions": min_pipeline,
            "close_rate_min": close_min,
            "min_spend_usd": min_spend,
            "decision": gate_decision,
        },
    )


# ── Helpers ──


def _block_record(
    m: ComboMetricsFD,
    original_decision: str,
    gated_decision: str,
    *,
    gate_stage: str,
    gate_reason: str | None = None,
    gate_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a standardized gate block record."""
    record: dict[str, Any] = {
        "combo_id": m.combo_id,
        "brand": m.brand,
        "pipeline_conversions": m.pipeline_conversions,
        "revenue_conversions": m.revenue_conversions,
        "close_rate": m.close_rate,
        "show_rate": m.show_rate,
        "spend_usd": m.spend_usd,
        "original_decision": original_decision,
        "gated_decision": gated_decision,
        "gate_stage": gate_stage,
    }
    if gate_reason is not None:
        record["gate_reason"] = gate_reason
    if gate_config is not None:
        record["gate_config"] = gate_config
    return record


def _gate_detail(m: ComboMetricsFD, gate_cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "pipeline_conversions": m.pipeline_conversions,
        "revenue_conversions": m.revenue_conversions,
        "close_rate": m.close_rate,
        "show_rate": m.show_rate,
        "attended_calls": m.attended_calls,
        "bookings": m.bookings,
        "close_rate_min": float(gate_cfg.get("close_rate_min", 0.05)),
        "min_pipeline_conversions": int(gate_cfg.get("min_pipeline_conversions", 20)),
    }
