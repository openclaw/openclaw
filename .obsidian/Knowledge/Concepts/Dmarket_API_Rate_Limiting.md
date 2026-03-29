# Dmarket API: Rate Limiting & Error Handling Strategies

#v16_knowledge #dmarket #api #rate_limit #error_handling

## Table of Contents

- [Rate Limits](#rate-limits)
- [Exponential Backoff](#exponential-backoff)
- [Circuit Breaker Pattern](#circuit-breaker-pattern)
- [Error Classification](#error-classification)
- [Retry Strategy Matrix](#retry-strategy-matrix)

## Rate Limits

```
Global: 10 requests/second per API key
Burst:  20 requests allowed in first second (token bucket)
Reset:  X-RateLimit-Reset header (Unix timestamp)

Headers in response:
  X-RateLimit-Limit: 10
  X-RateLimit-Remaining: 7
  X-RateLimit-Reset: 1700000060
```

> «Dmarket's rate limiter uses a sliding window algorithm. Bursting 20 requests will lock you out for 2 seconds. Consistent 8-9 req/sec is the optimal throughput.» — Dmarket API Best Practices

## Exponential Backoff

```python
import asyncio
import random

async def dmarket_request_with_backoff(
    session, method: str, url: str, max_retries: int = 5, **kwargs
) -> dict:
    """Dmarket API call with exponential backoff on rate limit."""
    for attempt in range(max_retries):
        async with session.request(method, url, **kwargs) as resp:
            if resp.status == 429:
                retry_after = int(resp.headers.get("X-RateLimit-Reset", 0))
                wait = max(retry_after - int(time.time()), 1)
                jitter = random.uniform(0, 0.5)
                await asyncio.sleep(wait + jitter)
                continue

            if resp.status == 503:
                # Service unavailable — exponential backoff
                wait = (2 ** attempt) + random.uniform(0, 1)
                await asyncio.sleep(min(wait, 30))
                continue

            resp.raise_for_status()
            return await resp.json()

    raise RuntimeError(f"Dmarket API failed after {max_retries} retries")
```

## Circuit Breaker Pattern

```python
from enum import Enum
from dataclasses import dataclass, field
import time

class CircuitState(Enum):
    CLOSED = "closed"       # Normal operation
    OPEN = "open"           # Failing — block requests
    HALF_OPEN = "half_open" # Testing recovery

@dataclass
class CircuitBreaker:
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    _failures: int = field(default=0, init=False)
    _state: CircuitState = field(default=CircuitState.CLOSED, init=False)
    _last_failure: float = field(default=0.0, init=False)

    def can_execute(self) -> bool:
        if self._state == CircuitState.CLOSED:
            return True
        if self._state == CircuitState.OPEN:
            if time.time() - self._last_failure > self.recovery_timeout:
                self._state = CircuitState.HALF_OPEN
                return True
            return False
        return True  # HALF_OPEN — allow one test request

    def record_success(self):
        self._failures = 0
        self._state = CircuitState.CLOSED

    def record_failure(self):
        self._failures += 1
        self._last_failure = time.time()
        if self._failures >= self.failure_threshold:
            self._state = CircuitState.OPEN
```

## Error Classification

| HTTP Code          | Retryable | Стратегия                         |
| ------------------ | --------- | --------------------------------- |
| 400 Bad Request    | ❌        | Исправить payload/params          |
| 401 Unauthorized   | ❌        | Проверить HMAC подпись, timestamp |
| 403 Forbidden      | ❌        | Проверить API ключ/разрешения     |
| 404 Not Found      | ❌        | Проверить endpoint/AssetID        |
| 429 Rate Limited   | ✅        | Wait X-RateLimit-Reset            |
| 500 Internal Error | ✅        | Exponential backoff               |
| 502 Bad Gateway    | ✅        | Retry with backoff                |
| 503 Unavailable    | ✅        | Retry with backoff (maintenance?) |

## Retry Strategy Matrix

```python
RETRY_STRATEGIES = {
    429: {"max_retries": 10, "strategy": "rate_limit_header"},
    500: {"max_retries": 3, "strategy": "exponential", "base_delay": 1.0},
    502: {"max_retries": 5, "strategy": "exponential", "base_delay": 0.5},
    503: {"max_retries": 5, "strategy": "exponential", "base_delay": 2.0},
}

def should_retry(status_code: int, attempt: int) -> tuple[bool, float]:
    config = RETRY_STRATEGIES.get(status_code)
    if not config or attempt >= config["max_retries"]:
        return False, 0

    if config["strategy"] == "rate_limit_header":
        return True, 1.0  # Placeholder — use header in practice

    delay = config["base_delay"] * (2 ** attempt) + random.uniform(0, 0.5)
    return True, min(delay, 30.0)
```

---

_Сгенерировано Knowledge Expansion v16.5_
