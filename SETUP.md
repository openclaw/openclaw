# OpenClaw Sandboxed Setup

Local sandboxed deployment of [OpenClaw](https://github.com/openclaw/openclaw) — a personal AI assistant platform — running in Docker via Colima on macOS.

## Architecture

```
macOS Host (Colima VM)
  └── Docker
       └── openclaw-gateway container (node:22-bookworm)
            ├── Gateway WebSocket server (port 18789)
            ├── Bridge server (port 18790)
            ├── Browser control (port 18791, internal)
            └── Channels: Telegram (@tillsclaw_bot), ...
```

- **Gateway**: WebSocket server at `ws://0.0.0.0:18789` (inside container), mapped to host
- **Agent model**: `anthropic/claude-sonnet-4-6` (via setup-token auth)
- **Config**: `~/.openclaw/openclaw.json`
- **Workspace**: `~/.openclaw/workspace/`

## Prerequisites

- Docker (via Colima): `colima start --cpu 4 --memory 8 --disk 60 --runtime docker`
- Docker Compose plugin: `brew install docker-compose`

## Quick Reference

### Start / Stop

```bash
cd /Users/tillkothe/Documents/Development/openclaw

# Start gateway
docker compose up -d openclaw-gateway

# Stop gateway (preserves data)
docker compose down

# View logs
docker compose logs openclaw-gateway -f --tail 50

# Check status
docker compose ps
```

### CLI Commands

```bash
# Interactive CLI session
docker compose run --rm openclaw-cli

# Send a message
docker compose run --rm openclaw-cli agent --message "Hello"

# Run doctor (security audit)
docker compose run --rm openclaw-cli doctor

# Manage channels
docker compose run --rm openclaw-cli channels list
docker compose run --rm openclaw-cli channels add --channel telegram --token <token>
docker compose run --rm openclaw-cli channels login  # WhatsApp QR

# Update config
docker compose run --rm openclaw-cli config set <key> <value>
docker compose run --rm openclaw-cli config get <key>
```

### Web Dashboard

Open in browser: `http://127.0.0.1:18789/`

Token-authenticated URL (auto-login):
```
http://127.0.0.1:18789/#token=<OPENCLAW_GATEWAY_TOKEN from .env>
```

## Update

```bash
cd /Users/tillkothe/Documents/Development/openclaw
git pull origin main
docker compose down
docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 -t openclaw:local -f Dockerfile .
docker compose up -d openclaw-gateway
```

## Backup

```bash
tar czf openclaw-backup-$(date +%Y%m%d).tar.gz -C ~ .openclaw
```

## Configuration Files

| File | Purpose |
|------|---------|
| `.env` | Docker Compose env vars (gateway token, paths, ports) |
| `~/.openclaw/openclaw.json` | Main OpenClaw config (model, channels, auth) |
| `docker-compose.yml` | Container service definitions |
| `Dockerfile` | Container image build definition |

## Security Notes

- Gateway runs as non-root user `node` (uid 1000)
- Auth token required for gateway access (auto-generated in `.env`)
- `.env` file permissions set to `600` (owner-only read)
- Telegram DM policy set to `pairing` (unknown senders must be approved)
- Group policy set to `allowlist` (add allowed sender IDs to use in groups)
- Docker CLI included in image for optional sandbox mode (`OPENCLAW_SANDBOX=1`)

### Optional Hardening (not yet applied)

To further lock down `docker-compose.yml`:

```yaml
# Localhost-only port binding (prevent LAN exposure)
ports:
  - "127.0.0.1:18789:18789"
  - "127.0.0.1:18790:18790"

# Drop all Linux capabilities
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true

# Resource limits
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 2G
```

### Re-running Onboarding

```bash
docker compose run --rm openclaw-cli onboard --mode local --no-install-daemon
```

### Refreshing Auth Token (Claude subscription)

In a separate terminal (not inside Claude Code):
```bash
claude setup-token
```
Then paste the token via:
```bash
docker compose run --rm openclaw-cli models auth paste-token --provider anthropic
```

## Troubleshooting

**Gateway restart loop**: Check logs with `docker compose logs openclaw-gateway --tail 30`. Common cause: missing `controlUi.allowedOrigins` when bind is `lan`. Fix:
```bash
docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
```

**Permission errors on volumes**: Expected on macOS with Colima — virtiofs handles permissions transparently. If persistent, try:
```bash
docker compose run --rm --user root --entrypoint sh openclaw-cli -c 'chown -R node:node /home/node/.openclaw'
```

**Build OOM (exit 137)**: Increase Colima RAM:
```bash
colima stop && colima start --cpu 4 --memory 12 --disk 60 --runtime docker
```
