"""CAC payback period gate — blocks scaling when payback exceeds horizon.

For Full Digital (one-time high-ticket):
  payback_ok = (net_revenue * gross_margin) >= CAC

For CUTMV (subscription SaaS):
  payback_days = CAC / (daily_margin)
  daily_margin = (LTV * gross_margin) / horizon_days
  payback_ok = payback_days <= max_payback_days

Blocks SCALE when CAC payback is unacceptable within the configured horizon.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PaybackResult:
    """Result of payback evaluation."""

    payback_days: float
    ok: bool
    reason: str


def payback_gate_one_time(
    *,
    cac: float,
    net_revenue: float,
    gross_margin: float,
    max_payback_days: int = 30,
) -> PaybackResult:
    """One-time revenue payback gate (Full Digital).

    If net margin from the deal covers CAC → ok immediately (0 days).
    If not → infinite payback (not ok).

    Args:
        cac: Customer acquisition cost (spend / closes).
        net_revenue: Net revenue per close (after refunds).
        gross_margin: Gross margin percentage (0-1).
        max_payback_days: Maximum acceptable payback period.

    Returns:
        PaybackResult.
    """
    if cac <= 0:
        return PaybackResult(payback_days=0.0, ok=True, reason="no_spend")

    margin = net_revenue * gross_margin
    if margin <= 0:
        return PaybackResult(
            payback_days=float("inf"), ok=False, reason="zero_margin"
        )

    if margin >= cac:
        return PaybackResult(payback_days=0.0, ok=True, reason="immediate_payback")

    # Partial payback — estimate days based on ratio
    ratio = margin / cac
    estimated_days = max_payback_days / ratio if ratio > 0 else float("inf")
    ok = estimated_days <= max_payback_days
    return PaybackResult(
        payback_days=estimated_days,
        ok=ok,
        reason="ok" if ok else "payback_exceeds_horizon",
    )


def payback_gate_subscription(
    *,
    cac: float,
    ltv_estimate: float,
    gross_margin: float,
    horizon_days: int = 60,
    max_payback_days: int = 45,
) -> PaybackResult:
    """Subscription payback gate (CUTMV SaaS).

    Uses LTV estimate to compute daily margin and payback period.

    Args:
        cac: Customer acquisition cost.
        ltv_estimate: Estimated lifetime value (from LTV engine).
        gross_margin: Gross margin percentage (0-1).
        horizon_days: Horizon over which LTV is measured.
        max_payback_days: Maximum acceptable payback days.

    Returns:
        PaybackResult.
    """
    if cac <= 0:
        return PaybackResult(payback_days=0.0, ok=True, reason="no_spend")

    total_margin = ltv_estimate * gross_margin
    if total_margin <= 0:
        return PaybackResult(
            payback_days=float("inf"), ok=False, reason="zero_ltv_margin"
        )

    daily_margin = total_margin / horizon_days
    if daily_margin <= 0:
        return PaybackResult(
            payback_days=float("inf"), ok=False, reason="zero_daily_margin"
        )

    payback_days = cac / daily_margin
    ok = payback_days <= max_payback_days
    return PaybackResult(
        payback_days=payback_days,
        ok=ok,
        reason="ok" if ok else "payback_exceeds_horizon",
    )
