---
tags:
  - dmarket
  - api
  - debugging
category: troubleshooting
difficulty: intermediate
training: true
created: 2026-03-29
---

## API Fix: Dmarket place offer

- **Error**: [API] 404 Endpoint not found
- **Fix**: Check item ID

## API Fix: Dmarket auth

- **Error**: [API] 401 Unauthorized — invalid token
- **Fix**: Regenerate API key

## API Fix: Dmarket rate limit

- **Error**: [API] 429 Too Many Requests Timeout 60s
- **Fix**: Exponential backoff

## API Fix: Dmarket API ConnectionError

- **Error**: [API] ConnectionError to api.dmarket.com
- **Fix**: Check VPN/network

## API Fix: Dmarket server crash

- **Error**: [API] 500 Internal server error
- **Fix**: Retry with backoff

## API Fix: User-reported error

- **Error**: [API] 500 Internal Server Error at /api/dmarket
- **Fix**: Учтено пользователем — применять немедленно.

## API Fix: API call to /v2/prices

- **Error**: [API] ❌ Execution Error: 404 Not Found
- **Fix**: [auto] Error pattern: ❌ Execution Error: 404 Not Found

## API Fix: Test resilience

- **Error**: [API] ConnectionError: refused
- **Fix**: [auto] Error pattern: ConnectionError: refused
