# OpenClaw Setup Learnings & Gotchas

Notes from the initial sandboxed Docker deployment on macOS (Colima).

---

## Docker on macOS (Colima)

### Image build takes 10-20 minutes
The `pnpm install` step downloads thousands of packages. Subsequent builds use Docker layer cache and are fast (~30s) unless `package.json` or `pnpm-lock.yaml` changes.

### File permission `chown` errors are harmless
When running `chown` inside containers on bind-mounted macOS volumes, you'll see "Permission denied" errors. This is expected — Colima's virtiofs handles permissions transparently. The `node` user can still read/write files fine.

### `docker-setup.sh` is interactive — can't run headlessly
The setup script runs `openclaw onboard` which requires TTY input. If running from an automated context, split the process:
1. Build image separately: `docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 -t openclaw:local -f Dockerfile .`
2. Run onboarding manually: `docker compose run --rm openclaw-cli onboard --mode local --no-install-daemon`
3. Set config and start: `docker compose up -d openclaw-gateway`

---

## Gateway Configuration

### `controlUi.allowedOrigins` required for non-loopback bind
When `gateway.bind` is `lan` (default in Docker), the gateway refuses to start without `gateway.controlUi.allowedOrigins`. Fix:
```bash
docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
```
The `docker-setup.sh` normally handles this via `ensure_control_ui_allowed_origins()`, but if you skip it, you must set it manually.

### Config changes require gateway restart
After any `config set` command, the gateway must be restarted:
```bash
docker compose restart openclaw-gateway
```

---

## Web Dashboard (Control UI)

### Docker bridge IP breaks auto-pairing
The docs say local connections from `127.0.0.1` are auto-approved for device pairing. However, when the gateway runs in Docker, the browser's connection arrives from the Docker bridge IP (`172.18.0.1`), which is treated as remote — requiring manual device approval.

**Fix**: Approve pending device requests via CLI:
```bash
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

### Token URL format
The dashboard accepts the gateway token in the URL hash:
```
http://127.0.0.1:18789/#token=<OPENCLAW_GATEWAY_TOKEN>
```
But the token alone doesn't bypass device pairing — you still need to approve the device first.

---

## Authentication

### Setup-token from Claude subscription
OpenClaw can use your Claude subscription (Pro/Max) instead of a separate API key:
1. Run `claude setup-token` in a terminal (NOT inside Claude Code — nested sessions crash)
2. During onboarding, choose "Anthropic token (paste setup-token)"
3. Or paste later: `docker compose run --rm openclaw-cli models auth paste-token --provider anthropic`

### Setup-tokens expire
If you get `HTTP 401: authentication_error: Invalid bearer token`, the setup-token has expired. Generate a fresh one with `claude setup-token` and paste it again.

---

## Messaging Channels

### Localhost binding doesn't affect channels
Binding the gateway to localhost only restricts the local control plane (CLI, web dashboard). Messaging channels (Telegram, Discord, Slack) use **outbound** connections from the container to external APIs — they work regardless of gateway bind mode.

### Telegram group policy
Default `groupPolicy: "allowlist"` with empty allowlist silently drops all group messages. Options:
- `open` — respond in all groups
- `deny` — DMs only, no groups
- Keep `allowlist` and add specific group IDs to `groupAllowFrom`

---

## Useful CLI Commands

```bash
# Start/stop
docker compose up -d openclaw-gateway
docker compose down
docker compose restart openclaw-gateway

# Logs
docker compose logs openclaw-gateway -f --tail 50

# Shell into container
docker compose exec openclaw-gateway bash

# One-off CLI commands (--rm cleans up after)
docker compose run --rm openclaw-cli <command>

# Health check
docker compose run --rm openclaw-cli doctor
docker compose run --rm openclaw-cli health

# Device management (for dashboard pairing)
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>

# Config
docker compose run --rm openclaw-cli config get <key>
docker compose run --rm openclaw-cli config set <key> <value>

# Channels
docker compose run --rm openclaw-cli channels list
docker compose run --rm openclaw-cli channels add --channel telegram --token <token>
```
