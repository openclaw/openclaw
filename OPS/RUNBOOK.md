# OpenClaw Two-Node Runbook

## Bring up Mac node

```bash
cd <repo-path-on-mac>
docker compose --env-file .env.mac up -d --build openclaw-gateway
```

Optional CLI tasks from Mac:

```bash
docker compose --env-file .env.mac run --rm openclaw-cli onboard
docker compose --env-file .env.mac run --rm openclaw-cli dashboard --no-open
```

## Bring up Windows node

```bash
cd <repo-path-on-windows>
docker compose --env-file .env.win up -d --build openclaw-gateway
```

Optional CLI tasks from Windows:

```bash
docker compose --env-file .env.win run --rm openclaw-cli dashboard --no-open
```

## Health checks

```bash
docker compose --env-file .env.mac ps
docker compose --env-file .env.mac logs --tail 120 openclaw-gateway
docker compose --env-file .env.mac exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

Windows version:

```bash
docker compose --env-file .env.win ps
docker compose --env-file .env.win logs --tail 120 openclaw-gateway
docker compose --env-file .env.win exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

## Deploy changes from Mac to Windows

```bash
# On Mac
git add -A
git commit -m "infra/docs: update OpenClaw two-node setup"
git push origin <branch>
```

```bash
# On Windows
cd <repo-path-on-windows>
git fetch origin
git checkout <branch>
git pull --rebase origin <branch>
docker compose --env-file .env.win up -d --build
```

## Data volumes and paths

- Container paths:
  - `/home/node/.openclaw`
  - `/home/node/.openclaw/workspace`
- Host paths are defined by env files:
  - `OPENCLAW_CONFIG_DIR`
  - `OPENCLAW_WORKSPACE_DIR`

## Restart and recovery

```bash
# Restart gateway only
docker compose --env-file .env.mac restart openclaw-gateway
docker compose --env-file .env.win restart openclaw-gateway
```

```bash
# Full recreate (safe default)
docker compose --env-file .env.mac down
docker compose --env-file .env.mac up -d --build
```

```bash
docker compose --env-file .env.win down
docker compose --env-file .env.win up -d --build
```

```bash
# Inspect recent logs after recovery
docker compose --env-file .env.mac logs --tail 200 openclaw-gateway
docker compose --env-file .env.win logs --tail 200 openclaw-gateway
```
