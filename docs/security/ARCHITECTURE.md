# 🏗️ Security Architecture & Design

This document details the technical implementation of the security hardening features in OpenClaw.

## 1. Rate Limiting (Anti-Brute Force)

**File:** `src/gateway/auth-rate-limit.ts`

We implemented a memory-based rate limiting system to protect the Gateway against brute-force attacks.

### Implementation Details

*   **Algorithm**: Token bucket / Failure counter per IP.
*   **Storage**: In-memory LRU Cache (max 1000 IPs) to prevent memory leaks.
*   **Thresholds**:
    *   **Max Attempts**: 5 failures.
    *   **Block Duration**: 15 minutes.
    *   **Reset Window**: 1 minute (counters reset if no failures occur for 1 min).

### Logic Flow

1.  Incoming request IP is resolved (trusting proxies if configured).
2.  **Before** any crypto or password verification is done, `checkRateLimit(ip)` is called.
3.  If blocked, request is rejected immediately (`429 Too Many Requests`).
4.  If allowed, auth proceeds.
    *   **On Failure**: `recordAuthFailure(ip)` increments counter. If > 5, IP is blocked.
    *   **On Success**: `recordAuthSuccess(ip)` clears the counter.

---

## 2. Password Hashing

**File:** `src/gateway/auth-password.ts`

Previously, passwords were stored in plain text in `~/.openclaw/openclaw.json`. We have introduced secure password hashing.

### Design Choice: `scrypt`

We chose **scrypt** over bcrypt or argon2 because:
1.  **Native Support**: Available in Node.js `crypto` module (no C++ compilation required).
2.  **OWASP Recommended**: Approved for password storage.
3.  **Memory-Hard**: Resistant to GPU/ASIC attacks compared to simple hash functions.

### Implementation

*   **Salt**: 16 bytes random salt per password.
*   **Parameters**: `N=16384`, `r=8`, `p=1` (Balanced for security/performance).
*   **Format**: `salt:derived_key` (hex encoded).
*   **Verification**: Uses `crypto.timingSafeEqual()` to prevent timing attacks continuously.

---

## 3. Visual Startup Warnings

**File:** `src/gateway/server-startup-log.ts`

To ensure users are aware of potential misconfigurations, we overhauled the startup logging.

### Features

*   **Risk Detection**: Checks if `bind` is non-loopback (exposed) AND (TLS is off OR Auth is weak).
*   **ASCII Banner**: A large, unmissable warning box is displayed in the logs.
*   **Delay**: A **5-second pause** occurs when a risk is detected, ensuring the user sees the message before it scrolls away.

**Example Warning:**

```text
╔═════════════════════════════════════════════════════════╗
║            ⚠️  SECURITY WARNING  ⚠️                     ║
║                                                         ║
║  Gateway is exposed on network!                        ║
║  Binding: 0.0.0.0                                      ║
║  TLS: DISABLED (traffic is unencrypted)                ║
║                                                         ║
║  Recommended:                                           ║
║  - Use bind='loopback' for local-only access           ║
╚═════════════════════════════════════════════════════════╝
```

---

## 4. Authentication Integration

**File:** `src/gateway/auth.ts`

The authentication logic was refactored to check rate limits **first** (fail-fast).

*   **Order of Operations**:
    1.  Resolve IP.
    2.  Check Rate Limit -> Reject if blocked.
    3.  Check Auth Token/Password.
    4.  Log result (Success/Failure) to Rate Limiter.

This ensures that attackers cannot consume CPU resources verifying passwords if they are already blocked.
