"""Stability Gate — evaluates whether a queued remainder scale is still justified.

Before requesting approval for a deferred budget increase, the stability gate
checks that the combo's performance hasn't degraded since the original request.

Checks (all configurable via ``stability_gate`` in experiment policy):
- Minimum sample size (spend + conversions)
- CPA stability vs baseline (max 25% worse)
- ROAS stability vs baseline (min 85% of prior)
- Creative fatigue score (max 0.70)
- Full Digital pipeline quality (calls, quality, close rate)

If the gate fails, the remainder is skipped (not retried) and a short
info-only Telegram message is sent.

Usage::

    gate = StabilityGate(policy=meta_policy, combo_metrics_store=store)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_14")
    if result.ok:
        # proceed to request approval
    else:
        # skip and notify
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class StabilityResult:
    """Outcome of a stability gate evaluation."""

    ok: bool
    reasons: list[str]
    metrics_now: dict[str, Any] = field(default_factory=dict)
    metrics_baseline: dict[str, Any] = field(default_factory=dict)
    confidence: str = "LOW"  # LOW | MED | HIGH


def _ratio(a: float, b: float) -> float:
    """Safe ratio: a/b, returning 999 when b==0 and a>0."""
    if b == 0:
        return 999.0 if a > 0 else 1.0
    return a / b


class StabilityGate:
    """Evaluate whether a queued remainder scale is still justified.

    Parameters
    ----------
    policy : dict
        The ``meta`` block from experiment policy (contains ``stability_gate``).
    combo_metrics_store : object | None
        Must expose ``get_combo_metrics(combo_id, brand, window) -> dict | None``.
        When *None*, gate always fails safe (insufficient data).
    """

    def __init__(
        self,
        policy: dict[str, Any],
        combo_metrics_store: Any = None,
    ) -> None:
        self.policy = policy
        self.store = combo_metrics_store

    def evaluate(self, *, brand: str, combo_id: str) -> StabilityResult:
        """Run all stability checks for *combo_id*."""
        p = self.policy.get("stability_gate", {})
        reasons: list[str] = []

        lookback_days = int(p.get("lookback_days", 2))

        # Fetch metrics
        now = self._get_metrics(combo_id, brand, "last_24h")
        base = self._get_metrics(combo_id, brand, f"prev_{lookback_days}d")

        if not now or not base:
            return StabilityResult(
                ok=False,
                reasons=[
                    "Insufficient metrics for stability check "
                    "(missing now/baseline)."
                ],
                metrics_now=now or {},
                metrics_baseline=base or {},
                confidence="LOW",
            )

        # ── Sample size gates ──
        min_spend = float(p.get("min_spend_usd", 30))
        min_conv = int(p.get("min_conversions", 2))

        spend_now = float(now.get("spend_usd", 0))
        conv_now = int(now.get("conversions", 0))

        if spend_now < min_spend:
            reasons.append(
                f"Spend below minimum (${min_spend:.0f}) for stability check."
            )
        if conv_now < min_conv:
            reasons.append(
                f"Conversions below minimum ({min_conv}) for stability check."
            )

        # ── CPA / ROAS stability ──
        max_cpa_increase = float(p.get("max_cpa_increase_ratio", 1.25))
        min_roas_ratio = float(p.get("min_roas_ratio_of_baseline", 0.85))

        cpa_now = float(now.get("cpa", 0) or 0)
        cpa_base = float(base.get("cpa", 0) or 0)
        roas_now = float(now.get("roas", 0) or 0)
        roas_base = float(base.get("roas", 0) or 0)

        if cpa_base > 0:
            cpa_ratio = _ratio(cpa_now, cpa_base)
            if cpa_ratio > max_cpa_increase:
                reasons.append(
                    f"CPA worsened: now/base={cpa_ratio:.2f} "
                    f"> {max_cpa_increase:.2f}."
                )

        if roas_base > 0:
            roas_ratio = _ratio(roas_now, roas_base)
            if roas_ratio < min_roas_ratio:
                reasons.append(
                    f"ROAS dropped: now/base={roas_ratio:.2f} "
                    f"< {min_roas_ratio:.2f}."
                )

        # ── Fatigue ──
        max_fatigue = float(p.get("max_fatigue_score", 0.70))
        fatigue = float(now.get("fatigue_score", 0) or 0)
        if fatigue > max_fatigue:
            reasons.append(
                f"Creative/angle fatigue high: {fatigue:.2f} "
                f"> {max_fatigue:.2f}."
            )

        # ── Full Digital pipeline quality ──
        if brand == "fulldigital":
            self._check_fulldigital(p, now, reasons)

        ok = len(reasons) == 0

        # Confidence heuristic
        confidence = "MED"
        if spend_now >= (min_spend * 2) and conv_now >= (min_conv * 2):
            confidence = "HIGH"
        if not ok and any("Insufficient" in r for r in reasons):
            confidence = "LOW"

        return StabilityResult(
            ok=ok,
            reasons=reasons,
            metrics_now=now,
            metrics_baseline=base,
            confidence=confidence,
        )

    def _get_metrics(
        self, combo_id: str, brand: str, window: str
    ) -> dict[str, Any] | None:
        if not self.store:
            return None
        try:
            return self.store.get_combo_metrics(
                combo_id=combo_id, brand=brand, window=window,
            )
        except Exception:
            return None

    @staticmethod
    def _check_fulldigital(
        policy: dict[str, Any],
        now: dict[str, Any],
        reasons: list[str],
    ) -> None:
        """Full Digital pipeline quality checks.

        Strict definitions:
        - ``calls_observed`` means **calls showed** (not booked).
          The metric key ``calls_showed`` from combo metrics is used directly.
        - ``close_rate`` is computed from Stripe paid only, refunds excluded
          (``net_usd > 0``).  The denominator is ``calls_showed``.
        - Pipeline quality minimum is enforced BEFORE the close-rate gate.
        """
        fd = policy.get("fulldigital", {})

        # STRICT: calls_showed only (not booked)
        calls_showed = int(now.get("calls_showed", 0) or 0)
        min_calls = int(fd.get("min_calls_observed", 10))

        if calls_showed < min_calls:
            return  # not enough data to evaluate pipeline quality

        pipeline_q = float(now.get("pipeline_quality", 0) or 0)
        close_rate = float(now.get("close_rate", 0) or 0)
        min_pq = float(fd.get("min_pipeline_quality", 0.60))
        min_close = float(fd.get("min_close_rate", 0.05))

        # Pipeline quality minimum BEFORE close-rate gate triggers
        if pipeline_q < min_pq:
            reasons.append(
                f"Pipeline quality below minimum: "
                f"{pipeline_q:.2f} < {min_pq:.2f}."
            )
        if close_rate < min_close:
            reasons.append(
                f"Close rate below minimum (net paid only): "
                f"{close_rate:.3f} < {min_close:.3f}."
            )
