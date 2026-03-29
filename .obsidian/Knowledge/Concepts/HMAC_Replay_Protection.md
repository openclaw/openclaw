# HMAC Replay Protection & Nonce Strategies

#v16_knowledge #hmac #security #replay #hft

## Table of Contents

- [The Replay Attack Problem](#the-replay-attack-problem)
- [Timestamp-Based Protection](#timestamp-based-protection)
- [Nonce-Based Protection](#nonce-based-protection)
- [Hybrid: Timestamp + Nonce](#hybrid-timestamp--nonce)
- [Dmarket Specific](#dmarket-specific)

## The Replay Attack Problem

Без replay protection атакующий может перехватить подписанный запрос и повторить его:

```
Attacker captures: POST /api/v1/order { "buy": "AK-47", "price": 10.00 }
Signature: valid HMAC
→ Re-sends the same request 1000 times → 1000 покупок
```

> «HMAC alone guarantees message integrity, NOT uniqueness. Replay protection requires an additional monotonic or random component in the signed payload.» — OWASP API Security Guide

## Timestamp-Based Protection

Самый простой подход — включить Unix timestamp в подпись:

```python
import time

TIMESTAMP_WINDOW = 30  # seconds

def validate_timestamp(received_ts: int) -> bool:
    now = int(time.time())
    return abs(now - received_ts) <= TIMESTAMP_WINDOW
```

| Плюсы                    | Минусы                             |
| ------------------------ | ---------------------------------- |
| Простая реализация       | Требует синхронизации часов        |
| Нет состояния на сервере | Окно уязвимости (30с)              |
| Естественный порядок     | NTP drift может вызвать отклонения |

## Nonce-Based Protection

Каждый запрос содержит уникальный одноразовый идентификатор:

```python
import secrets
import redis

_redis = redis.Redis()
NONCE_TTL = 300  # 5 minutes

def generate_nonce() -> str:
    return secrets.token_hex(16)

def validate_nonce(nonce: str) -> bool:
    """Returns True if nonce is fresh (not seen before)."""
    key = f"nonce:{nonce}"
    if _redis.exists(key):
        return False  # replay detected
    _redis.setex(key, NONCE_TTL, 1)
    return True
```

## Hybrid: Timestamp + Nonce

Для HFT оптимальный подход — комбинация:

```python
def sign_with_replay_protection(
    secret: bytes, method: str, path: str, body: str = ""
) -> dict:
    ts = str(int(time.time()))
    nonce = secrets.token_hex(8)
    message = f"{method}{path}{ts}{nonce}{body}"
    sig = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()
    return {"signature": sig, "timestamp": ts, "nonce": nonce}
```

## Dmarket Specific

Dmarket API требует:

- `X-Sign-Date`: Unix timestamp (секунды)
- `X-Request-Sign`: HMAC-SHA256 hex
- Окно: ±60 секунд
- Nonce: **не используется** (timestamp-only)

**Важно:** При массовом размещении ордеров (batch), каждый запрос должен иметь свой timestamp, даже если отправляется в одной секунде.

---

_Сгенерировано Knowledge Expansion v16.5_
