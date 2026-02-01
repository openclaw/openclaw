# ✅ Security Verification Guide

This guide explains how to verify that the security enhancements in OpenClaw are working correctly.

## 1. Automated Verification Script

The easiest way to check your system is the included shell script.

**Command:**
```bash
./security-verification.sh
```

**What it validates:**
*   **File Integrity**: Checks that security modules (`auth-rate-limit.ts`, etc.) exist.
*   **Imports**: Verifies `auth.ts` is actually importing the security modules.
*   **Configuration**: Runs `openclaw security audit` to check your config.
*   **Permissions**: Warns if sensitive files have wide permissions.

---

## 2. Automated Test Suite

We have added a dedicated test suite for security features.

**Command:**
```bash
node --test tests/security-test-suite.test.js
```

**Coverage (23 Tests):**
*   **Rate Limiting**: Verifies locking after 5 attempts, unlocking after 15m.
*   **Password Hashing**: Verifies hashing correctness and timing-safe comparison.
*   **Integration**: Tests the full auth flow including rate limit checks.

---

## 3. Manual Verification Steps

If you want to manually verify the features, follow these steps:

### Test Rate Limiting

1.  Start OpenClaw: `openclaw gateway start`
2.  Make a curl request with a **wrong token**:
    ```bash
    curl -H "Authorization: Bearer WRONG" http://localhost:18789/v1/models
    ```
3.  Repeat this **6 times**.
4.  **Result**: The 6th attempt should return `429 Too Many Requests`.

### Test Visual Warnings

1.  Configure OpenClaw to bind to all interfaces (`0.0.0.0`) without TLS (if safe to do so in your env).
    ```bash
    openclaw config set gateway.bind lan
    ```
2.  Start the gateway: `openclaw gateway start`
3.  **Result**: You should see a large ASCII **SECURITY WARNING** box and the server should pause for 5 seconds before starting.

### Test Password Hashing

*Currently, password hashing is implemented as a module. Full integration for auto-migrating passwords in `openclaw.json` is planned for the next release.*

To test the module manually via REPL:
```typescript
import { hashPassword, verifyPassword } from "./src/gateway/auth-password.js";
const hash = await hashPassword("secret");
console.log(await verifyPassword("secret", hash)); // true
```
