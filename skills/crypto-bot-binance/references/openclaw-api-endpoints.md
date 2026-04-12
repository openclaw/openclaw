# crypto_bot_binance OpenClaw API contract

Base path: `/api/openclaw`

If your deployment exposes the API under a different prefix, set `CRYPTO_BOT_BINANCE_API_PREFIX` in the skill environment.

Monitoring endpoints:

- `GET /health`
- `GET /status`
- `GET /balances`
- `GET /logs`
- `GET /settings`
- `GET /open-orders`
- `GET /executions`

Control endpoints:

- `POST /start`
- `POST /stop`
- `POST /pause`
- `POST /resume`
- `POST /sync`
- `POST /save-settings`
- `POST /test-connection`

Auth rules (from backend implementation):

- Token may be sent as `X-OpenClaw-Token` or `Authorization: Bearer <token>`.
- If `openclaw_shared_token` is set on server, token is required.
- Monitoring endpoints require `openclaw_api_enabled`; token depends on server config.
- Control endpoints require `openclaw_api_enabled` and configured token.
- Optional IP allowlist can block requests by source IP.
