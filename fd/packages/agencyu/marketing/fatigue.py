"""Angle fatigue detection — detects when a creative angle stops working.

Requires 2+ signals to trigger (reduces false positives):
  - High frequency (audience has seen the ad too many times)
  - CTR drop vs previous period
  - CPC increase vs previous period

When fatigued, action is ROTATE (generate new creative), not SCALE.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FatigueSignal:
    """Result of fatigue detection for a combo/angle."""

    fatigued: bool
    reasons: list[str] = field(default_factory=list)


def detect_fatigue(
    *,
    frequency: float,
    ctr_now: float,
    ctr_prev: float,
    cpc_now: float,
    cpc_prev: float,
    freq_threshold: float = 2.8,
    ctr_drop_pct: float = 35.0,
    cpc_increase_pct: float = 40.0,
    min_signals: int = 2,
) -> FatigueSignal:
    """Detect creative fatigue from performance signals.

    Args:
        frequency: Current ad frequency.
        ctr_now: Current CTR.
        ctr_prev: Previous period CTR (baseline).
        cpc_now: Current CPC.
        cpc_prev: Previous period CPC (baseline).
        freq_threshold: Frequency above which fatigue is suspected.
        ctr_drop_pct: CTR drop percentage that signals fatigue.
        cpc_increase_pct: CPC increase percentage that signals fatigue.
        min_signals: Minimum number of signals required to confirm fatigue.

    Returns:
        FatigueSignal with fatigued flag and list of reasons.
    """
    reasons: list[str] = []

    if frequency >= freq_threshold:
        reasons.append("high_frequency")

    if ctr_prev > 0 and ctr_now < ctr_prev * (1.0 - ctr_drop_pct / 100.0):
        reasons.append("ctr_drop")

    if cpc_prev > 0 and cpc_now > cpc_prev * (1.0 + cpc_increase_pct / 100.0):
        reasons.append("cpc_increase")

    fatigued = len(reasons) >= min_signals
    return FatigueSignal(fatigued=fatigued, reasons=reasons)
