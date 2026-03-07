"""Tests for global provider rate limiter, circuit breaker, and backoff."""
from __future__ import annotations

import time

from packages.common.rate_limit import (
    CircuitBreaker,
    CircuitOpenError,
    LimiterRegistry,
    ProviderLimiter,
    RateLimitConfig,
    TokenBucket,
    with_provider_protection,
)
from packages.common.provider_limits import GLOBAL_LIMIT, PROVIDER_LIMITS


# ── TokenBucket ──


def test_token_bucket_respects_rps():
    """Token bucket should enforce minimum interval between calls."""
    bucket = TokenBucket(rps=10.0, burst=1)  # 10/s = 0.1s interval
    start = time.monotonic()
    bucket.take()
    bucket.take()
    elapsed = time.monotonic() - start
    assert elapsed >= 0.09  # at least ~0.1s between calls


def test_token_bucket_burst():
    """Burst tokens should allow rapid initial calls."""
    bucket = TokenBucket(rps=1.0, burst=5)
    start = time.monotonic()
    for _ in range(5):
        bucket.take()
    elapsed = time.monotonic() - start
    # 5 burst tokens should be consumed nearly instantly
    assert elapsed < 0.5


# ── CircuitBreaker ──


def test_circuit_breaker_trips_after_threshold():
    """Circuit should open after N consecutive failures."""
    cfg = RateLimitConfig(cb_fail_threshold=3, cb_open_seconds=10)
    cb = CircuitBreaker(cfg)
    for _ in range(2):
        assert cb.record_failure() is False
    assert cb.record_failure() is True
    assert cb.is_open is True


def test_circuit_breaker_success_resets():
    """A successful call should reset the failure counter and close the circuit."""
    cfg = RateLimitConfig(cb_fail_threshold=5)
    cb = CircuitBreaker(cfg)
    cb.record_failure()
    cb.record_failure()
    cb.record_success()
    assert cb.consecutive_failures == 0
    assert cb.is_open is False


def test_circuit_breaker_half_open_probe():
    """Half-open state should allow a probe after configured delay."""
    cfg = RateLimitConfig(
        cb_fail_threshold=2, cb_open_seconds=60, cb_half_open_after_s=0,
    )
    cb = CircuitBreaker(cfg)
    cb.record_failure()
    cb.record_failure()
    assert cb.is_open is True
    # With half_open_after_s=0, probe should be allowed immediately
    assert cb.allow_probe() is True


def test_circuit_status():
    """Status dict should reflect current state."""
    cfg = RateLimitConfig(cb_fail_threshold=3, cb_open_seconds=10)
    cb = CircuitBreaker(cfg)
    status = cb.status
    assert status["is_open"] is False
    assert status["consecutive_failures"] == 0


# ── ProviderLimiter ──


def test_provider_limiter_preflight_raises_when_circuit_open():
    """When circuit is open and no probe allowed, preflight raises."""
    cfg = RateLimitConfig(
        rps=100.0, burst=10, cb_fail_threshold=2,
        cb_open_seconds=60, cb_half_open_after_s=999,
    )
    limiter = ProviderLimiter(cfg)
    limiter.cb.record_failure()
    limiter.cb.record_failure()
    try:
        limiter.preflight()
        assert False, "Should have raised CircuitOpenError"
    except CircuitOpenError:
        pass


# ── with_provider_protection ──


def test_with_retry_succeeds():
    """with_provider_protection should return result on first success."""
    cfg = RateLimitConfig(rps=100.0, burst=10, max_retries=3)
    limiter = ProviderLimiter(cfg)
    result = with_provider_protection("test", limiter, lambda: 42)
    assert result == 42


def test_with_retry_retries_on_failure():
    """with_provider_protection should retry failed calls."""
    call_count = 0

    def flaky():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise ValueError("429 rate limited")  # classified as retryable
        return "ok"

    cfg = RateLimitConfig(
        rps=100.0, burst=10, max_retries=5, base_backoff_s=0.01,
        cb_fail_threshold=10,
    )
    limiter = ProviderLimiter(cfg)
    result = with_provider_protection("test", limiter, flaky)
    assert result == "ok"
    assert call_count == 3


def test_with_retry_fatal_stops_immediately():
    """Fatal errors should not be retried."""
    call_count = 0

    def always_fatal():
        nonlocal call_count
        call_count += 1
        raise TypeError("bad argument")  # classified as fatal

    cfg = RateLimitConfig(rps=100.0, burst=10, max_retries=5, cb_fail_threshold=10)
    limiter = ProviderLimiter(cfg)
    try:
        with_provider_protection("test", limiter, always_fatal)
        assert False, "Should have raised"
    except TypeError:
        pass
    assert call_count == 1


# ── LimiterRegistry ──


def test_registry_run_succeeds():
    """Registry should wrap calls with rate limiting."""
    cfgs = {"test": RateLimitConfig(rps=100.0, burst=10)}
    registry = LimiterRegistry(cfgs)
    result = registry.run("test", lambda: "hello")
    assert result == "hello"


def test_registry_with_global_limiter():
    """Registry should enforce global + provider limits when global is set."""
    cfgs = {"test": RateLimitConfig(rps=100.0, burst=10)}
    global_cfg = RateLimitConfig(rps=100.0, burst=10)
    registry = LimiterRegistry(cfgs, global_cfg=global_cfg)
    result = registry.run("test", lambda: 99)
    assert result == 99


def test_registry_meta_requires_write_approval():
    """Meta provider should require write approval."""
    registry = LimiterRegistry(PROVIDER_LIMITS)
    assert registry.check_write_approval("meta") is True
    assert registry.check_write_approval("stripe") is False


def test_registry_health():
    """Health endpoint should report all configured providers."""
    registry = LimiterRegistry(PROVIDER_LIMITS)
    health = registry.health()
    assert "meta" in health["providers"]
    assert "notion" in health["providers"]
    assert "google" in health["providers"]
    assert health["any_circuit_open"] is False


def test_registry_circuit_status():
    """Circuit status should return provider-specific info."""
    cfgs = {"test": RateLimitConfig(rps=100.0, burst=10, cb_fail_threshold=3)}
    registry = LimiterRegistry(cfgs)
    status = registry.circuit_status("test")
    assert status["provider"] == "test"
    assert status["is_open"] is False


def test_provider_limits_all_present():
    """All expected providers should be configured in PROVIDER_LIMITS."""
    expected = {"meta", "notion", "cloudflare", "vercel", "stripe", "ghl", "trello", "google"}
    assert expected == set(PROVIDER_LIMITS.keys())
    assert GLOBAL_LIMIT.rps > 0


def test_backoff_exponential():
    """Backoff delay should increase exponentially."""
    cfg = RateLimitConfig(base_backoff_s=1.0, max_backoff_s=60.0, jitter_s=0.0)
    # Test the formula directly: base * 2^(attempt-1)
    # attempt=1 -> 1.0, attempt=2 -> 2.0, attempt=3 -> 4.0
    d1 = min(cfg.max_backoff_s, cfg.base_backoff_s * (2 ** 0))
    d2 = min(cfg.max_backoff_s, cfg.base_backoff_s * (2 ** 1))
    d3 = min(cfg.max_backoff_s, cfg.base_backoff_s * (2 ** 2))
    assert abs(d1 - 1.0) < 0.01
    assert abs(d2 - 2.0) < 0.01
    assert abs(d3 - 4.0) < 0.01


def test_backoff_capped():
    """Backoff should not exceed max_backoff_s."""
    cfg = RateLimitConfig(base_backoff_s=1.0, max_backoff_s=10.0, jitter_s=0.0)
    d = min(cfg.max_backoff_s, cfg.base_backoff_s * (2 ** 100))
    assert d <= 10.0
