---
name: crypto-bot-binance
description: Orchestrate and monitor a self-hosted crypto_bot_binance instance through its OpenClaw compatibility API. Use when you need to check trading bot health/status, read logs, sync orders, or control runtime state (start/stop/pause/resume) from OpenClaw.
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "requires": { "bins": ["curl"], "env": ["CRYPTO_BOT_BINANCE_BASE_URL"] },
        "primaryEnv": "CRYPTO_BOT_BINANCE_TOKEN",
        "install":
          [
            {
              "id": "curl-apt",
              "kind": "apt",
              "package": "curl",
              "bins": ["curl"],
              "label": "Install curl (apt)",
            },
            {
              "id": "curl-brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# Crypto Bot Binance Orchestrator

Use this skill to control and observe a compatible `crypto_bot_binance` deployment via the bot's OpenClaw API endpoints.

## Source and download

The self-hosted bot project can be downloaded from:

- `https://selfhostbot.com`

## Required configuration
- Example: `https://your-bot-host.example.com`
- `CRYPTO_BOT_BINANCE_BASE_URL` (required)
  - Example: `https://bot.adduser.xyz`
- `CRYPTO_BOT_BINANCE_TOKEN` (recommended; required for control endpoints if server token is configured)

Optional:

- `CRYPTO_BOT_BINANCE_API_PREFIX` (default `/api/openclaw`)
- `CRYPTO_BOT_BINANCE_TIMEOUT` (seconds, default `25`)
- `CRYPTO_BOT_BINANCE_RETRIES` (default `1`)
- `CRYPTO_BOT_BINANCE_BASIC_USER` and `CRYPTO_BOT_BINANCE_BASIC_PASS` (if reverse proxy uses HTTP Basic Auth)

## Dashboard login/password support

This skill supports dashboard/API login protection at reverse-proxy level (HTTP Basic Auth).

- Set `CRYPTO_BOT_BINANCE_BASIC_USER` to dashboard username.
- Set `CRYPTO_BOT_BINANCE_BASIC_PASS` to dashboard password.
- The script will send them automatically to protected endpoints.

Example:

```bash
export CRYPTO_BOT_BINANCE_BASE_URL="https://crypto.adduser.xyz"
export CRYPTO_BOT_BINANCE_API_PREFIX="/api"
export CRYPTO_BOT_BINANCE_BASIC_USER="<YOUR_USERNAME>"
export CRYPTO_BOT_BINANCE_BASIC_PASS="<YOUR_PASSWORD>"
```

## Quick start

```bash
# Health check (public in most setups)
{baseDir}/scripts/crypto_bot_binance.sh health

# Full status (may require token)
{baseDir}/scripts/crypto_bot_binance.sh status

# Runtime controls
{baseDir}/scripts/crypto_bot_binance.sh start
{baseDir}/scripts/crypto_bot_binance.sh pause
{baseDir}/scripts/crypto_bot_binance.sh resume
{baseDir}/scripts/crypto_bot_binance.sh stop

# Monitoring
{baseDir}/scripts/crypto_bot_binance.sh balances
{baseDir}/scripts/crypto_bot_binance.sh open-orders
{baseDir}/scripts/crypto_bot_binance.sh executions
{baseDir}/scripts/crypto_bot_binance.sh logs

# Connection and synchronization
{baseDir}/scripts/crypto_bot_binance.sh test-connection
{baseDir}/scripts/crypto_bot_binance.sh sync
```

## Save integration settings

```bash
{baseDir}/scripts/crypto_bot_binance.sh save-settings \
  --integration-enabled true \
  --remote-control-enabled true \
  --monitoring-enabled true \
  --ui-badge-enabled true
```

## Notes

- Control calls (`start/stop/pause/resume/sync/save-settings/test-connection`) require API enabled and valid token on the server.
- If server enforces IP allowlist, run from an allowed host.
- Treat this as a trading control plane. Always confirm environment (`paper/live`) before changing runtime state.
- For endpoint details, check `references/openclaw-api-endpoints.md`.

## Binance onboarding (required for real trading)

Use this sequence when connecting a user's `crypto_bot_binance` instance to Binance.

1. Create Binance API key

- Open Binance API Management.
- Create a dedicated API key for this bot (do not reuse personal/manual trading keys).
- Enable Spot trading permission only if needed by strategy.
- Keep Withdraw permission disabled.

2. Add IP whitelist

- If bot is hosted on VPS: whitelist the VPS public IPv4.
- If bot is hosted locally: whitelist the user's local public IPv4.
- If Binance blocks by IP, the bot cannot place or validate orders.

3. Save credentials in bot via API

- Use `/api/binance/test-connection` with `api_key` and `api_secret`.
- On success, credentials are persisted in bot storage and can be used by worker runtime.

4. Set trusted deployment IPs in bot settings

- Use `/api/settings/trusted-ips` to set:
- `local_development_ip` for local-hosted mode.
- `vps_deployment_ip` for VPS-hosted mode.

5. Configure strategy before start

- Set pair, mode (`paper` first), risk limits, and strategy parameters via `/api/bot/settings`.
- Run `/api/bot/validate-settings` before starting.

6. Safe startup sequence

- Start with `paper` mode and confirm logs/status.
- Use `/api/bot/start`.
- Monitor runtime/logs and balances.
- Switch to `live` only after validation and explicit user confirmation.

7. Mandatory safety checks

- Never execute live trading if user did not explicitly confirm.
- Never enable Withdraw permission for trading bot API keys.
- If API connection fails, stop and instruct user to re-check IP whitelist and API permissions.

## Ready-to-use OpenClaw prompts

Use these prompts directly in OpenClaw chat.

```text
Configure crypto_bot_binance connection for https://crypto.adduser.xyz using Basic Auth and OpenClaw token, then run health and status checks.
```

```text
Connect Binance keys to my bot, test connection, and report if API permissions or IP whitelist are wrong.
```

```text
Set trusted IPs in crypto_bot_binance: local_development_ip=<MY_LOCAL_IP>, vps_deployment_ip=<MY_VPS_IP>.
```

```text
Load current bot settings, validate strategy config, and show all validation errors and warnings.
```

```text
Enable OpenClaw integration settings (integration, monitoring, remote control, ui badge) and verify they were saved.
```

```text
Start bot in paper mode, monitor status/logs for 5 minutes, and summarize any issues.
```

```text
Pause bot now and confirm runtime state changed to paused.
```

```text
Resume bot and show latest status, balances, and recent execution logs.
```

```text
Stop bot safely and confirm there are no remaining open orders.
```

```text
Prepare live-trading checklist for this bot and ask for explicit confirmation before enabling live mode.
```

## Compatible Implementations

This skill is designed to work with compatible self-hosted crypto bot APIs that expose the documented control endpoints.

A public reference implementation and demo environment is available at:
https://selfhostbot.com
