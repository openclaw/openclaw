---
summary: "Gateway request rate limiting: pre-auth brute-force lockout and the control-plane write backstop"
read_when:
  - A client sees `rate limit exceeded for <method>` or `AUTH_RATE_LIMITED` errors
  - You want to tune or disable `gateway.auth.rateLimit`
  - You are reasoning about brute-force protection on an exposed Gateway
title: "Rate limiting"
---

The Gateway enforces two independent rate limiters. They protect different
boundaries and fail with different error shapes.

## Authentication attempts (pre-auth)

Failed authentication attempts are throttled per client IP, before any
request handling. This is the brute-force guard for exposed Gateways.

- Only _wrong_ credentials count. Missing credentials (a client that never
  sent a token) and successful authentications do not consume budget; a
  successful auth resets the counter for that IP.
- Defaults: 10 failures per 60 seconds, then a 5 minute lockout for that IP.
- Loopback (`127.0.0.1` / `::1`) is exempt by default so local CLI sessions
  cannot be locked out.
- Counters are scoped per credential class (shared token/password, device
  token, node pairing, bootstrap token, hook auth, ...), so a flood against
  one surface does not displace another.

While locked out, connection attempts fail with:

```json
{
  "code": "INVALID_REQUEST",
  "message": "unauthorized: too many failed authentication attempts (retry later)",
  "retryable": true,
  "retryAfterMs": 297000,
  "details": {
    "code": "AUTH_RATE_LIMITED",
    "authReason": "rate_limited",
    "recommendedNextStep": "wait_then_retry"
  }
}
```

Attempts from other IPs (including loopback) are unaffected during a lockout.

Tune it under `gateway.auth.rateLimit` in `openclaw.json`:

```json
{
  "gateway": {
    "auth": {
      "rateLimit": {
        "maxAttempts": 10,
        "windowMs": 60000,
        "lockoutMs": 300000,
        "exemptLoopback": true
      }
    }
  }
}
```

Repeated `AUTH_RATE_LIMITED` entries in the Gateway log mean someone is
guessing credentials; see the [exposure runbook](/gateway/security/exposure-runbook).

## Control-plane writes (post-auth backstop)

Write-side admin RPCs (`config.apply`, `config.patch`, `plugins.install`,
`plugins.setEnabled`, `plugins.uninstall`, `update.run`, `worktrees.*`,
`gateway.restart.request`, ...) are additionally rate-limited **after**
authorization: 30 requests per 60 seconds, per method, per
`deviceId+clientIp`.

This is not a security boundary — callers already hold `operator.admin` — it
is a backstop that bounds runaway client or agent loops hammering expensive
operations. Interactive use never hits it; each method has its own bucket, so
toggling a plugin does not consume the budget of config writes.

When exceeded, the request fails with a retryable error:

```json
{
  "code": "UNAVAILABLE",
  "message": "rate limit exceeded for config.patch; retry after 35s",
  "retryable": true,
  "retryAfterMs": 34539,
  "details": { "method": "config.patch", "limit": "30 per 60s" }
}
```

Clients should honor `retryAfterMs`. The limit is fixed (not configurable);
buckets expire on their own and are pruned by Gateway maintenance.
