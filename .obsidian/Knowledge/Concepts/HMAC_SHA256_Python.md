# HMAC-SHA256: Python Implementation

#v16_knowledge #hmac #python #signing

## Table of Contents

- [Standard Library Approach](#standard-library-approach)
- [Dmarket API Signing](#dmarket-api-signing)
- [Async-Safe Signing](#async-safe-signing)
- [Testing & Verification](#testing--verification)

## Standard Library Approach

```python
import hmac
import hashlib
import time

def sign_request(secret_key: bytes, method: str, path: str, body: str = "") -> str:
    """Generate HMAC-SHA256 signature for API request."""
    timestamp = str(int(time.time()))
    message = f"{method}{path}{timestamp}{body}"
    signature = hmac.new(
        secret_key,
        message.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return signature, timestamp
```

> «Always use `hmac.compare_digest()` for signature comparison to prevent timing side-channel attacks.» — Python Security Best Practices

## Dmarket API Signing

Dmarket использует специфический формат подписи:

```python
import hmac
import hashlib
import json
from urllib.parse import urlencode

def dmarket_sign(
    api_secret: str,
    method: str,
    path: str,
    query_params: dict | None = None,
    body: dict | None = None,
    timestamp: str = "",
) -> str:
    """Dmarket-specific HMAC-SHA256 signing.

    Signature = HMAC-SHA256(secret, method + path + query + body + timestamp)
    """
    query_str = urlencode(query_params, doseq=True) if query_params else ""
    body_str = json.dumps(body, separators=(",", ":")) if body else ""

    string_to_sign = f"{method}{path}"
    if query_str:
        string_to_sign += f"?{query_str}"
    string_to_sign += body_str + timestamp

    sig = hmac.new(
        api_secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return sig
```

## Async-Safe Signing

В HFT-контексте подпись должна быть неблокирующей:

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor

_sign_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="hmac")

async def async_sign(secret: bytes, message: str) -> str:
    """Non-blocking HMAC signing for async event loops."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _sign_pool,
        lambda: hmac.new(secret, message.encode(), hashlib.sha256).hexdigest(),
    )
```

## Testing & Verification

```python
def test_hmac_deterministic():
    key = b"test-secret-key-32-bytes-long!!"
    msg = "GETapi/v1/prices1700000000"
    sig1 = hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()
    sig2 = hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()
    assert sig1 == sig2, "HMAC must be deterministic"
    assert len(sig1) == 64, "SHA-256 hex digest is 64 characters"

def test_hmac_tamper_detection():
    key = b"secret"
    sig_ok = hmac.new(key, b"original", hashlib.sha256).hexdigest()
    sig_bad = hmac.new(key, b"Original", hashlib.sha256).hexdigest()
    assert sig_ok != sig_bad, "Any change must produce different HMAC"
```

---

_Сгенерировано Knowledge Expansion v16.5_
