# HMAC Key Management & Rotation for Trading Systems

#v16_knowledge #hmac #key_management #security #hft

## Table of Contents

- [Key Storage Hierarchy](#key-storage-hierarchy)
- [Rotation Strategy](#rotation-strategy)
- [Dual-Key Transition](#dual-key-transition)
- [Environment Variable Safety](#environment-variable-safety)
- [Vault Integration](#vault-integration)

## Key Storage Hierarchy

```
Production HFT System:
├── HSM (Hardware Security Module)     → Идеально для institutional trading
├── Secrets Manager (AWS/Azure/GCP)   → Для cloud-deployed bots
├── Encrypted .env + keyring          → Для local development
└── Plain .env                        → ❌ НЕДОПУСТИМО в production
```

> «API keys should be treated with the same security posture as private SSH keys — never stored in plaintext, never committed to version control.» — CIS Benchmark for API Security

## Rotation Strategy

| Сценарий             | Частота ротации | Метод                      |
| -------------------- | --------------- | -------------------------- |
| Routine              | Каждые 90 дней  | Scheduled automation       |
| Compromise suspected | Немедленно      | Emergency revoke + reissue |
| Personnel change     | В течение 24ч   | Revoke старых ключей       |
| Post-incident        | Немедленно      | Full key rotation          |

## Dual-Key Transition

Безпростойная ротация — принимаем ОБА ключа в переходный период:

```python
import hmac
import hashlib

class DualKeyVerifier:
    """Accept signatures from both old and new keys during rotation."""

    def __init__(self, current_key: bytes, previous_key: bytes | None = None):
        self.current_key = current_key
        self.previous_key = previous_key

    def sign(self, message: bytes) -> str:
        """Always sign with current key."""
        return hmac.new(self.current_key, message, hashlib.sha256).hexdigest()

    def verify(self, message: bytes, signature: str) -> bool:
        """Verify against current key, fallback to previous."""
        expected = hmac.new(self.current_key, message, hashlib.sha256).hexdigest()
        if hmac.compare_digest(expected, signature):
            return True
        if self.previous_key:
            expected_old = hmac.new(self.previous_key, message, hashlib.sha256).hexdigest()
            return hmac.compare_digest(expected_old, signature)
        return False
```

## Environment Variable Safety

```python
import os
import base64

def load_api_secret() -> bytes:
    """Load API secret with validation."""
    raw = os.environ.get("DMARKET_API_SECRET", "")
    if not raw:
        raise RuntimeError("DMARKET_API_SECRET not set")
    if len(raw) < 32:
        raise RuntimeError("API secret too short (min 32 chars)")
    # Dmarket keys are Base64-encoded
    try:
        return base64.b64decode(raw)
    except Exception:
        return raw.encode("utf-8")
```

## Vault Integration

Для OpenClaw Bot — интеграция с `~/.openclaw/credentials/`:

```python
from pathlib import Path
import json

CRED_DIR = Path.home() / ".openclaw" / "credentials"

def get_dmarket_keys() -> tuple[str, str]:
    cred_file = CRED_DIR / "dmarket.json"
    if not cred_file.exists():
        raise FileNotFoundError(f"Credentials not found: {cred_file}")
    data = json.loads(cred_file.read_text())
    return data["api_key"], data["api_secret"]
```

---

_Сгенерировано Knowledge Expansion v16.5_
