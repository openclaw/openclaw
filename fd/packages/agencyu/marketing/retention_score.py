"""Content retention score — creative quality signal for scaling decisions.

Uses Meta Insights retention metrics (thruplay rate, hold rate) to detect
whether a creative is genuinely engaging or just clickbait.

Low retention = creative is lying about performance → block scaling.
High retention = creative is sticky → bonus to scaling confidence.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RetentionScore:
    """Retention evaluation result for a combo's creative."""

    value: float
    band: str  # "low", "ok", "high"
    multiplier: float


def retention_band(value: float, low: float, high: float) -> str:
    """Classify retention value into band."""
    if value < low:
        return "low"
    if value >= high:
        return "high"
    return "ok"


def retention_multiplier(
    value: float,
    *,
    low: float = 0.12,
    high: float = 0.22,
    penalty: float = 0.65,
    bonus: float = 1.15,
) -> RetentionScore:
    """Compute retention multiplier for scaling decisions.

    Args:
        value: Retention metric value (e.g., thruplay_rate).
        low: Threshold below which retention is "low" (penalized).
        high: Threshold above which retention is "high" (bonus).
        penalty: Multiplier for low retention (< 1.0 reduces scaling).
        bonus: Multiplier for high retention (> 1.0 boosts scaling).

    Returns:
        RetentionScore with band and multiplier.
    """
    band = retention_band(value, low, high)
    if band == "low":
        mult = penalty
    elif band == "high":
        mult = bonus
    else:
        mult = 1.0
    return RetentionScore(value=value, band=band, multiplier=mult)
