---
name: docker-manager
description: "Manage MaxBot's Docker containers: status, logs, restart, rebuild, and health checks. Use when user asks about MaxBot's status, wants to restart/rebuild the bot, check logs, or troubleshoot the gateway."
metadata: { "openclaw": { "emoji": "🐳", "requires": { "bins": ["docker"] } } }
---

# Docker Manager

Manage MaxBot's Docker containers from within MaxBot itself. Monitor health, tail logs, restart services, and trigger rebuilds — all via the exec tool.

## When to Use

✅ **Activate on:**

- "restart MaxBot", "restart the gateway", "restart the bot"
- "MaxBot status", "is the gateway running?", "health check"
- "show logs", "gateway logs", "tail the logs"
- "rebuild MaxBot", "rebuild docker", "rebuild the image"
- "which containers are running?", "docker ps"
- "stop/start [service]"
- "MaxBot is slow — what's using resources?"

## Working Directory

All commands run from the repo:

```
/Users/Dave/Documents/reaction_engine_with_decoder_layer_fix4/_references/openclaw
```

## Common Commands

### Status & Health

```bash
# All running containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# MaxBot-specific containers
docker compose --env-file .env.safe ps

# Container resource usage
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
```

### Logs

```bash
# Gateway logs (last 100 lines)
docker compose --env-file .env.safe logs --tail=100 openclaw-gateway

# Follow live logs
docker compose --env-file .env.safe logs -f openclaw-gateway

# All services
docker compose --env-file .env.safe logs --tail=50

# Filter for errors
docker compose --env-file .env.safe logs --tail=200 openclaw-gateway | grep -i "error\|warn\|fail"
```

### Restart

```bash
# Restart gateway only (fast, keeps image)
docker compose --env-file .env.safe restart openclaw-gateway

# Full recreate (picks up config changes from .env.safe)
docker compose --env-file .env.safe up -d --force-recreate openclaw-gateway

# Restart all services
docker compose --env-file .env.safe up -d --force-recreate
```

### Rebuild (full Docker build + redeploy)

```bash
# Build new image (takes 1–3 min)
docker build -t openclaw:local-safe .

# Redeploy with new image
docker compose --env-file .env.safe up -d --force-recreate
```

### Stop / Remove

```bash
# Stop all MaxBot containers (non-destructive)
docker compose --env-file .env.safe stop

# Remove containers (volumes preserved)
docker compose --env-file .env.safe down
```

## Service Names

| Service      | Container Name                       |
| ------------ | ------------------------------------ |
| Main gateway | `openclaw-openclaw-gateway-1`        |
| CLI helper   | `openclaw-openclaw-cli-1`            |
| Voicebox     | `openclaw-voicebox-1`                |
| Signal       | depends on signal-cli container name |

## Rules

1. **Always use `--env-file .env.safe`** with docker compose commands — config lives there.
2. **Run from the repo dir** — all relative paths assume `/Users/Dave/Documents/reaction_engine_with_decoder_layer_fix4/_references/openclaw`.
3. **Confirm before rebuild** — a full `docker build` takes 1–3 minutes; confirm with user before running.
4. **Prefer restart over recreate** — `restart` is faster; only use `--force-recreate` if user changed `.env.safe` or the config.
5. **Tail logs after restart** — always show the last 20 lines of logs after a restart so user can confirm the gateway came up cleanly.
6. **Exec approval required** — exec calls need gateway approval. This is expected behavior.

## Quick Health Check Template

Run this to confirm everything is healthy after a restart:

```bash
docker compose --env-file .env.safe ps && \
docker compose --env-file .env.safe logs --tail=20 openclaw-gateway
```
