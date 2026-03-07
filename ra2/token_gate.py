"""
ra2.token_gate — Token estimation and hard cap enforcement.

Provides a fast, deterministic token estimator (no external tokenizer dependency)
and gate logic that prevents any prompt from exceeding MAX_TOKENS.
"""

import os

# Configurable via environment or direct override
MAX_TOKENS: int = int(os.environ.get("RA2_MAX_TOKENS", "6000"))
LIVE_WINDOW: int = int(os.environ.get("RA2_LIVE_WINDOW", "16"))
LIVE_WINDOW_MIN: int = 4  # Never shrink below this


class TokenBudgetExceeded(Exception):
    """Raised when prompt exceeds MAX_TOKENS even after shrinking."""

    def __init__(self, estimated: int, limit: int):
        self.estimated = estimated
        self.limit = limit
        super().__init__(
            f"Token budget exceeded: {estimated} > {limit} after all shrink attempts"
        )


def estimate_tokens(text: str) -> int:
    """Fast deterministic token estimate.

    Base ratio: ~3.3 chars/token (conservative vs the common ~4 estimate).
    Applies a penalty when non-ASCII density is high, since code symbols
    and multilingual characters tend to produce shorter tokens.
    No external dependency.
    """
    if not text:
        return 0
    length = len(text)
    non_ascii = sum(1 for ch in text if ord(ch) > 127)
    ratio = non_ascii / length if length else 0
    # Shift from 3.3 toward 2.5 chars/token as non-ASCII density rises
    chars_per_token = 3.3 - (0.8 * ratio)
    return max(1, int(length / chars_per_token))


def check_budget(estimated: int, limit: int | None = None) -> bool:
    """Return True if *estimated* is within budget, False otherwise."""
    limit = limit if limit is not None else MAX_TOKENS
    return estimated <= limit


def shrink_window(current_window: int) -> int:
    """Halve the live window, respecting the minimum.

    Returns the new window size, or raises TokenBudgetExceeded if
    already at minimum.
    """
    if current_window <= LIVE_WINDOW_MIN:
        raise TokenBudgetExceeded(
            estimated=0,  # caller should fill real value
            limit=MAX_TOKENS,
        )
    return max(LIVE_WINDOW_MIN, current_window // 2)
