---
name: sync-openclaw
description: Sync the local fork with upstream openclaw, rebuild, restart all services, and verify everything is running (gateway, Mattermost channels, CRONs, mem0, slash commands).
---

# Sync OpenClaw

Use this skill to sync the local repo with upstream, rebuild, and redeploy. Follow every step in order. Do not skip steps. If any step fails, stop and report.

## Steps

### 1. Commit local changes (if any)

Check `git status`. If there are uncommitted changes, commit them before proceeding. Use `--no-verify` only if pre-commit failures are pre-existing and unrelated to the changes.

### 2. Fetch and merge upstream

```sh
git fetch upstream
git merge upstream/main -X ours
```

If there are conflicts even with `-X ours`, stop and report to the user. Do not force-resolve.

### 3. Install dependencies

```sh
pnpm install
```

### 4. Rebuild

```sh
pnpm build
pnpm ui:build
```

Both must succeed. If `ui:build` fails on missing deps, rerun `pnpm install` and retry once.

### 5. Rebuild Docker image

```sh
docker build -t openclaw:local .
```

This bakes the freshly built dist + UI assets into the container image. If the build fails with `ERR_PNPM_OUTDATED_LOCKFILE`, run `pnpm install` again and retry. The gateway runs from this image — skipping this step means the container keeps running stale code.

### 6. Ensure Docker/OrbStack is running

```sh
orb start  # or: open -a OrbStack
```

Wait until `docker info` succeeds.

### 7. Start Mattermost (if not running)

```sh
cd /Users/renas/Projects/mattermost/deploy && docker compose up -d
```

Wait until `curl -s http://localhost:30065/api/v4/system/ping` returns 200.

### 8. Start memory stack (if not running)

```sh
docker compose -f docker-compose.memory.yml up -d
```

### 9. Restart the gateway

```sh
docker compose -f docker-compose.yml up -d
```

This recreates the containers with the newly built image. Wait 10-15 seconds for startup.

### 10. Verify everything

Run all checks and report results in a table:

| Check               | Command                                | Expected                                       |
| ------------------- | -------------------------------------- | ---------------------------------------------- |
| Gateway             | `openclaw channels status --probe`     | "Gateway reachable"                            |
| Mattermost channels | same output                            | All configured bots show "connected" + "works" |
| CRONs               | `openclaw cron list`                   | All jobs listed with schedules                 |
| mem0                | `curl -s http://localhost:8420/health` | `{"status":"ok"}`                              |

If any check fails, investigate and fix before reporting success.

### 11. Push

```sh
git push origin main
```

## Notes

- The Docker gateway container (`openclaw-openclaw-gateway-1`) is the primary gateway. Do not start a second local gateway with `openclaw gateway run` — it will conflict.
- Mattermost lives in a separate repo at `/Users/renas/Projects/mattermost/deploy`.
- mem0 is exposed on port 8420 (mapped from container port 8000).
- If `pnpm build` is skipped after a merge, the mattermost plugin and other extensions WILL break at runtime due to stale dist output. Never skip the build step.
