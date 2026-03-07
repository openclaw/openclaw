"""Close-rate uncertainty via Beta distribution + scaling confidence.

Models close rate as Beta(alpha=closes+1, beta=calls-closes+1) and
draws Monte Carlo samples to estimate the confidence interval.

If the CI is wide (volatile close rate), scaling confidence is reduced.
Policy can use this to downgrade SCALE → SCALE_SOFT or HOLD.
"""
from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass
class CloseRateUncertainty:
    """Result of Beta CI estimation for close rate."""

    mean: float
    p05: float
    p95: float
    width: float  # p95 - p05


def beta_ci(
    closes: int,
    calls: int,
    *,
    iterations: int = 2000,
) -> CloseRateUncertainty:
    """Compute close-rate uncertainty via Beta distribution Monte Carlo.

    Args:
        closes: Number of closed deals (Stripe paid).
        calls: Number of observed calls.
        iterations: Number of Monte Carlo draws.

    Returns:
        CloseRateUncertainty with mean, p05, p95, width.
    """
    alpha = closes + 1
    beta_param = max(0, calls - closes) + 1
    samples = sorted(random.betavariate(alpha, beta_param) for _ in range(iterations))
    n = len(samples)
    mean = sum(samples) / n
    p05 = samples[int(0.05 * (n - 1))]
    p95 = samples[int(0.95 * (n - 1))]
    return CloseRateUncertainty(mean=mean, p05=p05, p95=p95, width=p95 - p05)


def scaling_confidence_from_uncertainty(
    unc: CloseRateUncertainty,
    penalty_weight: float = 0.35,
) -> float:
    """Convert CI width into a 0-1 scaling confidence.

    Narrower CI → higher confidence → stronger scaling.
    Wider CI → lower confidence → softer scaling or hold.

    Args:
        unc: CloseRateUncertainty from beta_ci().
        penalty_weight: How strongly width reduces confidence.

    Returns:
        Float in [0.0, 1.0].
    """
    width = max(1e-6, unc.width)
    # 0.30 width is roughly "very volatile" benchmark
    confidence = 1.0 - min(1.0, penalty_weight * width / 0.30)
    return max(0.0, min(1.0, confidence))
