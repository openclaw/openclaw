# Password Policy

GovDOSS™ / CMMC Level 2 (CP-7) password controls.

## Complexity Requirements

| Rule              | Requirement                             |
| ----------------- | --------------------------------------- |
| Minimum length    | 12 characters                           |
| Uppercase         | At least one A–Z                        |
| Lowercase         | At least one a–z                        |
| Digit             | At least one 0–9                        |
| Special character | At least one non-alphanumeric character |

## Hashing Algorithm

Passwords are hashed with **scrypt** (Node.js `crypto.scrypt`):

| Parameter  | Value          | Notes                    |
| ---------- | -------------- | ------------------------ |
| `N` (cost) | 65536 (2¹⁶)    | CPU/memory cost          |
| `r`        | 8              | Block size               |
| `p`        | 1              | Parallelism              |
| Salt       | 256-bit random | Per-password unique salt |
| Key length | 64 bytes       | Output                   |

scrypt at N=65536 is approximately equivalent to bcrypt cost factor 12 in
terms of resistance to brute-force. It is a NIST-accepted memory-hard KDF and
requires no external dependencies.

Stored format: `scrypt:<N>:<r>:<p>:<salt_hex>:<hash_hex>`

Parameters are embedded in the stored string so that future cost adjustments
don't invalidate existing hashes.

## Password History

The last **5** password hashes are retained per account. Reusing any of the
last 5 passwords is rejected at change time.

## Password Change Flow

1. Caller provides current password for verification.
2. New password is validated against complexity rules.
3. New password is checked against history (last 5 hashes).
4. New hash is computed and stored; old hash moves to history.

## API

```typescript
import {
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
} from "src/gateway/auth/password-policy.js";

// Validate complexity
const result = validatePasswordStrength(candidate);
if (!result.valid) {
  console.error(result.errors.join(", "));
}

// Hash
const hash = await hashPassword(password);

// Verify (timing-safe)
const ok = await verifyPassword(candidate, storedHash);
```
