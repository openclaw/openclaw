# PoC: Device Token Verification/Revocation TOCTOU Race

## Vulnerability
`src/infra/device-pairing.ts:770-818` — `verifyDeviceToken()` and
`revokeDeviceToken()` each hold the async lock independently. A concurrent
revocation can occur after verify succeeds but before the caller acts on it.

## Severity: HIGH

## Affected Code

```typescript
// verifyDeviceToken (line 777): acquires lock, checks revokedAtMs, releases lock
// revokeDeviceToken (line 959): acquires lock, sets revokedAtMs, releases lock
// Caller uses verify result AFTER lock is released
```

## Proof of Concept

### Race Condition Timeline

```
Thread A (attacker):         Thread B (admin):
─────────────────            ─────────────────
verifyDeviceToken()
  → withLock() acquired
  → revokedAtMs is null ✓
  → token matches ✓
  → returns { ok: true }
  → lock released
                             revokeDeviceToken()
                               → withLock() acquired
                               → sets revokedAtMs = Date.now()
                               → persists state
                               → lock released
Caller uses { ok: true }
  → Performs privileged action
  → Uses revoked token!
```

### Exploitation Scenario

1. Admin notices compromised device, initiates revocation
2. Attacker's device simultaneously sends authenticated request
3. `verifyDeviceToken` returns `{ ok: true }` (checked before revocation)
4. Admin's `revokeDeviceToken` completes (token now revoked)
5. Attacker's request proceeds with now-revoked credentials
6. Attacker can approve exec requests, send messages, read conversations

### Same Pattern in Bootstrap Token

```typescript
// src/infra/device-bootstrap.ts:298-370
// verifyDeviceBootstrapToken() — same lock-per-function pattern
// redeemDeviceBootstrapTokenProfile() — can race with revocation
```

## Root Cause

The `withLock()` pattern protects individual function reads/writes from
concurrent modification, but does NOT protect the caller's use of the result.
The lock scope is too narrow — it should encompass the entire
verify-then-act operation.

## Impact

- Revoked device tokens can be used for one additional privileged operation
- Compromised devices can race admin revocation to perform final actions
- Bootstrap tokens can be redeemed after revocation during concurrent pairing

## Remediation

See patch: Add `verifyAndUseDeviceToken()` that combines verification and
action within a single lock scope, with re-validation before use.
