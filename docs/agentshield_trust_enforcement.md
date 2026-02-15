# AgentShield Trust Enforcement

Runtime trust enforcement for OpenClaw — verifies publisher keyrings and
revocation lists before allowing tool calls.

## Configuration

All settings are read from environment variables. Strict requirements default
to **off** so enabling trust enforcement is non-breaking.

| Variable                          | Default                         | Description                                                                       |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `AGENTSHIELD_TRUST_ROOT`          | _(none)_                        | Path to AgentShield trust root directory. Setting this enables trust enforcement. |
| `AGENTSHIELD_REVOCATIONS_FILE`    | `<TRUST_ROOT>/revocations.json` | Path to signed revocation list. Defaults to `revocations.json` inside trust root. |
| `AGENTSHIELD_REQUIRE_KEYRING`     | `0`                             | When `1`, block tool calls whose signing key is not in the publisher keyring.     |
| `AGENTSHIELD_REQUIRE_NOT_REVOKED` | `0`                             | When `1`, block tool calls from revoked publishers or artifacts.                  |
| `AGENTSHIELD_KEYS_DIR`            | _(none)_                        | Directory for local signer keys (if needed).                                      |

### Minimal setup

```bash
export AGENTSHIELD_TRUST_ROOT=/path/to/trust_root
```

This loads revocations and keyrings for **warning-only** mode. Revoked
publishers/artifacts generate warnings in logs but do not block execution.

### Recommended production settings

```bash
export AGENTSHIELD_TRUST_ROOT=/path/to/trust_root
export AGENTSHIELD_REQUIRE_KEYRING=1
export AGENTSHIELD_REQUIRE_NOT_REVOKED=1
```

This enforces both keyring verification and revocation checks. Tool calls
from revoked publishers or with unrecognized signing keys are blocked.

## How revocations are checked

1. The revocations file is loaded from `AGENTSHIELD_REVOCATIONS_FILE` (or
   `<TRUST_ROOT>/revocations.json`).
2. If the file is a signed envelope (`{ payload, signature, public_key }`),
   the ed25519 signature is verified.
3. The file is cached in memory. On subsequent calls, the file's mtime is
   checked — the cache reloads only when the file changes on disk.
4. At tool-call time, the following are checked against the revocation list:
   - `kind=pubkey` — publisher public key
   - `kind=trust_card` — trust card identifier
   - `kind=skill_attestation` — artifact content SHA-256
5. Expired revocations (where `expires_at < now`) are ignored.
6. When `REQUIRE_NOT_REVOKED=1`: a match → **BLOCK**.
   When `REQUIRE_NOT_REVOKED=0`: a match → **WARN** (logged, not blocked).

### Revocation list format

```json
{
  "payload": {
    "type": "agentshield.revocations",
    "schema": "agentshield.revocation_list.v1",
    "issued_at": "2025-01-01T00:00:00Z",
    "publisher_id": "your-publisher-id",
    "revocations": [
      {
        "kind": "pubkey",
        "id": "<publisher-pubkey-hex>",
        "reason": "compromised key",
        "revoked_at": "2025-01-01T00:00:00Z"
      }
    ]
  },
  "signature": "<hex>",
  "public_key": "<hex>"
}
```

## How keyring enforcement works

1. Keyrings are stored at `<TRUST_ROOT>/publishers/<publisher_id>/keyring.json`.
2. A keyring contains one or more keys with status: `active`, `retired`, or
   `revoked`.
3. Exactly one key must be `active` for the keyring to be considered valid.
4. At verification time:
   - The signing key's public key is looked up in the publisher's keyring.
   - `active` and `retired` keys are accepted.
   - `revoked` keys cause a **BLOCK**.
   - Keys not found in the keyring cause a **BLOCK** (when `REQUIRE_KEYRING=1`).
5. Signed keyrings (envelope format) have their own signature verified first.

### Keyring format

```json
{
  "schema": "agentshield.publisher_keyring.v1",
  "publisher_id": "your-publisher-id",
  "keys": [
    {
      "key_id": "key-2025-01",
      "alg": "ed25519",
      "pubkey": "<hex>",
      "status": "active",
      "created_at": "2025-01-01T00:00:00Z"
    }
  ]
}
```

## Middleware chain

Trust enforcement runs as the **first** wrapper in the tool middleware chain:

```
tool → trust enforcement → approval gate → before-tool-call hook → abort signal
```

When a tool call is blocked, the agent receives a structured JSON response:

```json
{
  "status": "blocked",
  "tool": "tool_name",
  "reason": "publisher 'xyz' is revoked: compromised key",
  "hint": "Check trust root: /path/to/trust_root and revocations: /path/to/revocations.json."
}
```

## Decision receipt verification

If OpenClaw consumes signed decision receipts, the receipt signature is
verified against the publisher keyring. When `REQUIRE_KEYRING=1` and
verification fails, the receipt is treated as a **BLOCK**.

## Operator-facing error messages

| Scenario                    | Message                                                     |
| --------------------------- | ----------------------------------------------------------- |
| Revoked publisher           | `Blocked: publisher '<id>' is revoked: <reason>`            |
| Revoked artifact            | `Blocked: artifact is revoked: <reason>`                    |
| Revoked trust card          | `Blocked: trust card is revoked: <reason>`                  |
| Key not in keyring          | `Blocked: signing key not found in publisher keyring`       |
| Revoked key in keyring      | `Blocked: signing key '<key_id>' is revoked`                |
| Receipt verification failed | `Blocked: receipt signature verification failed — <reason>` |

Each block message includes a hint pointing to the trust root and revocations
file paths for troubleshooting.
