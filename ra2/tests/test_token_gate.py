"""Tests for ra2.token_gate"""

import pytest
from ra2.token_gate import (
    estimate_tokens,
    check_budget,
    shrink_window,
    TokenBudgetExceeded,
    LIVE_WINDOW_MIN,
)


class TestEstimateTokens:
    def test_empty_string(self):
        assert estimate_tokens("") == 0

    def test_short_string(self):
        assert estimate_tokens("ab") == 1

    def test_known_length_ascii(self):
        text = "a" * 400
        # 400 / 3.3 ≈ 121
        assert estimate_tokens(text) == int(400 / 3.3)

    def test_proportional(self):
        short = estimate_tokens("hello world")
        long = estimate_tokens("hello world " * 100)
        assert long > short

    def test_non_ascii_increases_estimate(self):
        ascii_text = "a" * 100
        # Mix in non-ASCII to trigger the penalty
        non_ascii_text = "\u4e00" * 100  # CJK characters
        assert estimate_tokens(non_ascii_text) > estimate_tokens(ascii_text)

    def test_code_heavy_reasonable(self):
        code = 'def foo(x: int) -> bool:\n    return x > 0\n' * 10
        tokens = estimate_tokens(code)
        # Should be more conservative than len//4
        assert tokens > len(code) // 4


class TestCheckBudget:
    def test_within_budget(self):
        assert check_budget(100, limit=200) is True

    def test_at_budget(self):
        assert check_budget(200, limit=200) is True

    def test_over_budget(self):
        assert check_budget(201, limit=200) is False


class TestShrinkWindow:
    def test_halves(self):
        assert shrink_window(16) == 8

    def test_halves_again(self):
        assert shrink_window(8) == 4

    def test_at_minimum_raises(self):
        with pytest.raises(TokenBudgetExceeded):
            shrink_window(LIVE_WINDOW_MIN)

    def test_below_minimum_raises(self):
        with pytest.raises(TokenBudgetExceeded):
            shrink_window(2)

    def test_odd_number(self):
        # 5 // 2 = 2, but clamped to LIVE_WINDOW_MIN (4)
        assert shrink_window(5) == LIVE_WINDOW_MIN


class TestTokenBudgetExceeded:
    def test_attributes(self):
        exc = TokenBudgetExceeded(estimated=7000, limit=6000)
        assert exc.estimated == 7000
        assert exc.limit == 6000
        assert "7000" in str(exc)
        assert "6000" in str(exc)
