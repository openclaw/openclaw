# @openclaw/clawhub-rate-limit

Rate limit visibility layer for Clawhub — adds standard rate limit headers to every response, a JSON status endpoint, and a real-time dashboard.

## Features

- **Sliding window** rate limiting via Redis sorted sets
- **Standard headers** on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **429 responses** with `Retry-After` when limit exceeded
- **Status endpoint** (`GET /rate-limit/status`) — queries Redis directly, exempt from rate limiting
- **Dashboard** (`GET /dashboard`) — live-polling HTML UI showing usage

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `RATE_LIMIT_WINDOW_SEC` | `60` | Sliding window size in seconds |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | `3000` | Server listen port |

## Usage

```bash
cd packages/clawhub-rate-limit
npm install
REDIS_URL=redis://localhost:6379 npm start
```

## Integration with Clawhub gateway

The middleware can be imported standalone:

```js
const { rateLimiter } = require('@openclaw/clawhub-rate-limit/src/middleware/rateLimiter');
app.use(rateLimiter);
```

## Design decisions

- **Rate limit key uses `req.ip`** (not `x-api-key`) to prevent bucket spoofing by unauthenticated clients
- **Status route queries Redis directly** instead of depending on `req.rateLimitInfo` from middleware — avoids ordering dependency and works even when the route is exempt from rate limiting
- **Fail-open on Redis errors** — if Redis is down, requests pass through rather than blocking all traffic
