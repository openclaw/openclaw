"""Global provider rate limiter — thread-safe token bucket, circuit breaker, backoff.

Anti-ban / anti-rate-limit hardening for all external providers (Meta, Notion,
Stripe, Cloudflare, Vercel, etc.).

Features:
- Token bucket per provider (configurable RPS + burst)
- Circuit breaker with half-open probing
- Exponential backoff + jitter on retries
- Max retries with audit logging
- Error classification (retryable vs fatal)
- "No risky automation without approval" enforcement for Meta writes
- LimiterRegistry for centralized provider + global limiting

Usage::

    from packages.common.rate_limit import LimiterRegistry, RateLimitConfig

    registry = LimiterRegistry(PROVIDER_CONFIGS, global_cfg=GLOBAL_CONFIG)

    # Wrapped call with full protection:
    result = registry.run("meta", lambda: meta_client.get_insights(...))

    # Or manual acquire/record:
    limiter = registry.get("notion")
    limiter.preflight()  # blocks until token available; raises if circuit open
    try:
        result = notion_client.pages.retrieve(page_id)
        limiter.cb.record_success()
    except Exception:
        limiter.cb.record_failure()
        raise
"""
from __future__ import annotations

import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

from packages.common.logging import get_logger

log = get_logger("common.rate_limit")

T = TypeVar("T")


class CircuitOpenError(Exception):
    """Raised when the circuit breaker is open and no probe is allowed."""

    def __init__(self, provider: str, open_until: float) -> None:
        self.provider = provider
        self.open_until = open_until
        remaining = max(0, open_until - time.time())
        super().__init__(
            f"Circuit breaker open for {provider}, "
            f"retry in {remaining:.0f}s"
        )


@dataclass
class RateLimitConfig:
    """Per-provider rate limit and circuit breaker settings."""

    # Token bucket
    rps: float = 1.0              # tokens per second
    burst: int = 5                # max burst tokens
    # Retries
    max_retries: int = 5
    base_backoff_s: float = 1.0
    max_backoff_s: float = 60.0
    jitter_s: float = 0.4
    # Circuit breaker
    cb_fail_threshold: int = 6    # failures before open
    cb_open_seconds: int = 900    # 15 min cooldown
    cb_half_open_after_s: int = 120  # probe window
    # Write approval
    requires_write_approval: bool = False


class TokenBucket:
    """Thread-safe token bucket rate limiter.

    Refills at ``rps`` tokens per second up to ``capacity``.
    Calling ``take()`` blocks until a token is available.
    """

    def __init__(self, rps: float, burst: int) -> None:
        self.rps = max(0.01, float(rps))
        self.capacity = max(1, int(burst))
        self.tokens = float(self.capacity)
        self.last = time.monotonic()
        self.lock = threading.Lock()

    def take(self, n: float = 1.0) -> None:
        """Block until ``n`` tokens are available, then consume them."""
        while True:
            with self.lock:
                now = time.monotonic()
                elapsed = now - self.last
                self.last = now
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rps)

                if self.tokens >= n:
                    self.tokens -= n
                    return

                needed = (n - self.tokens) / self.rps
            time.sleep(min(needed, 0.5))


class CircuitBreaker:
    """Thread-safe circuit breaker with half-open probing.

    States:
    - **Closed**: all requests pass through.
    - **Open**: requests blocked until ``open_until`` expires.
    - **Half-open**: one probe request allowed after ``cb_half_open_after_s``
      since the last failure, to test if the provider has recovered.
    """

    def __init__(self, cfg: RateLimitConfig) -> None:
        self.cfg = cfg
        self.fail_count = 0
        self.open_until = 0.0  # wall-clock timestamp
        self.last_fail_ts = 0.0
        self.lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        with self.lock:
            return time.time() < self.open_until

    def allow_probe(self) -> bool:
        """Check if a half-open probe is allowed."""
        with self.lock:
            now = time.time()
            if now >= self.open_until:
                return True  # circuit is closed
            return (now - self.last_fail_ts) >= self.cfg.cb_half_open_after_s

    def record_success(self) -> None:
        """Reset failure counter and close the circuit."""
        with self.lock:
            self.fail_count = 0
            self.open_until = 0.0

    def record_failure(self) -> bool:
        """Record a failure. Returns True if the circuit just tripped."""
        with self.lock:
            self.fail_count += 1
            self.last_fail_ts = time.time()
            if self.fail_count >= self.cfg.cb_fail_threshold:
                self.open_until = time.time() + self.cfg.cb_open_seconds
                return True
            return False

    @property
    def consecutive_failures(self) -> int:
        with self.lock:
            return self.fail_count

    @property
    def status(self) -> dict[str, Any]:
        with self.lock:
            now = time.time()
            is_open = now < self.open_until
            return {
                "is_open": is_open,
                "consecutive_failures": self.fail_count,
                "open_until_remaining_s": max(0, self.open_until - now) if is_open else 0,
                "last_fail_ts": self.last_fail_ts,
            }


class ProviderLimiter:
    """Combined token bucket + circuit breaker for a single provider."""

    def __init__(self, cfg: RateLimitConfig) -> None:
        self.cfg = cfg
        self.bucket = TokenBucket(cfg.rps, cfg.burst)
        self.cb = CircuitBreaker(cfg)

    def preflight(self) -> None:
        """Acquire a rate limit token. Raises CircuitOpenError if breaker is open."""
        if self.cb.is_open and not self.cb.allow_probe():
            raise CircuitOpenError(
                provider="unknown", open_until=self.cb.open_until
            )
        self.bucket.take(1.0)


def _sleep_backoff(cfg: RateLimitConfig, attempt: int) -> float:
    """Calculate and sleep for exponential backoff with jitter. Returns delay used."""
    exp = min(cfg.max_backoff_s, cfg.base_backoff_s * (2 ** max(0, attempt - 1)))
    jitter = random.random() * cfg.jitter_s
    delay = min(cfg.max_backoff_s, exp + jitter)
    time.sleep(delay)
    return delay


def _default_classify_error(exc: Exception) -> str:
    """Classify an exception as retryable or fatal based on common signals."""
    msg = str(exc).lower()
    if any(s in msg for s in ("429", "rate", "timeout", "temporar", "5xx", "circuit_open")):
        return "retryable"
    status_code = getattr(getattr(exc, "response", None), "status_code", None)
    if status_code is not None:
        if status_code == 429 or 500 <= status_code < 600:
            return "retryable"
    return "fatal"


def with_provider_protection(
    provider: str,
    limiter: ProviderLimiter,
    fn: Callable[[], T],
    *,
    classify_error: Callable[[Exception], str] | None = None,
) -> T:
    """Run ``fn()`` with token bucket, circuit breaker, and retry protection.

    Parameters
    ----------
    provider : str
        Provider name for logging.
    limiter : ProviderLimiter
        The limiter instance to use.
    fn : callable
        Zero-arg callable to execute.
    classify_error : callable, optional
        Maps exceptions to ``"retryable"`` or ``"fatal"``.
        Defaults to heuristic based on status codes and error messages.

    Returns
    -------
    The return value of ``fn()``.

    Raises
    ------
    The last exception if all retries are exhausted, or immediately for fatal errors.
    """
    classifier = classify_error or _default_classify_error
    cfg = limiter.cfg
    last_exc: Exception | None = None

    for attempt in range(1, cfg.max_retries + 1):
        try:
            limiter.preflight()
            result = fn()
            limiter.cb.record_success()
            return result
        except CircuitOpenError:
            raise
        except Exception as exc:
            last_exc = exc
            kind = classifier(exc)
            tripped = limiter.cb.record_failure()

            if tripped:
                log.warning(
                    "provider_circuit_tripped",
                    extra={
                        "provider": provider,
                        "cooldown_s": cfg.cb_open_seconds,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )

            if kind == "fatal" or attempt == cfg.max_retries:
                log.error(
                    "provider_call_failed",
                    extra={
                        "provider": provider,
                        "attempt": attempt,
                        "fatal": kind == "fatal",
                        "error": str(exc),
                    },
                )
                raise

            delay = _sleep_backoff(cfg, attempt)
            log.info(
                "provider_retry",
                extra={
                    "provider": provider,
                    "attempt": attempt,
                    "delay_s": round(delay, 2),
                },
            )

    raise last_exc  # type: ignore[misc]  # unreachable but satisfies type checker


class LimiterRegistry:
    """Central registry enforcing per-provider + optional global rate limits.

    Usage::

        registry = LimiterRegistry(PROVIDER_CONFIGS, global_cfg=GLOBAL_CONFIG)
        result = registry.run("notion", lambda: notion_client.pages.retrieve(page_id))
    """

    def __init__(
        self,
        provider_cfgs: dict[str, RateLimitConfig],
        global_cfg: RateLimitConfig | None = None,
    ) -> None:
        self._providers: dict[str, ProviderLimiter] = {
            k: ProviderLimiter(v) for k, v in provider_cfgs.items()
        }
        self._cfgs = dict(provider_cfgs)
        self._global: ProviderLimiter | None = (
            ProviderLimiter(global_cfg) if global_cfg else None
        )
        self._global_cfg = global_cfg

    def get(self, provider: str) -> ProviderLimiter:
        """Get or create a ProviderLimiter for the given provider."""
        if provider not in self._providers:
            self._providers[provider] = ProviderLimiter(RateLimitConfig())
        return self._providers[provider]

    def run(
        self,
        provider: str,
        fn: Callable[[], T],
        *,
        classify_error: Callable[[Exception], str] | None = None,
    ) -> T:
        """Execute ``fn()`` with provider + optional global rate limiting."""
        limiter = self.get(provider)

        if self._global:
            return with_provider_protection(
                f"{provider}+global",
                self._global,
                lambda: with_provider_protection(
                    provider, limiter, fn, classify_error=classify_error,
                ),
                classify_error=classify_error,
            )

        return with_provider_protection(
            provider, limiter, fn, classify_error=classify_error,
        )

    def check_write_approval(self, provider: str) -> bool:
        """Return True if the provider requires explicit write approval."""
        cfg = self._cfgs.get(provider, RateLimitConfig())
        return cfg.requires_write_approval

    def circuit_status(self, provider: str) -> dict[str, Any]:
        """Return circuit breaker status for a provider."""
        limiter = self.get(provider)
        status = limiter.cb.status
        status["provider"] = provider
        return status

    def health(self) -> dict[str, Any]:
        """Return health status for all tracked providers."""
        statuses = {}
        for p in sorted(self._providers):
            statuses[p] = {
                "circuit_open": self._providers[p].cb.is_open,
                "consecutive_failures": self._providers[p].cb.consecutive_failures,
            }
        return {
            "providers": statuses,
            "any_circuit_open": any(
                self._providers[p].cb.is_open for p in self._providers
            ),
        }
