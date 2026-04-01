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

### 5. Ensure Docker/OrbStack is running (for Mattermost + memory stack only)

```sh
orb start  # or: open -a OrbStack
```

Wait until `docker info` succeeds.

### 6. Start Mattermost (if not running)

```sh
cd /Users/renas/Projects/mattermost/deploy && docker compose up -d
```

Wait until `curl -s http://localhost:30065/api/v4/system/ping` returns 200.

### 7. Start memory stack (if not running)

```sh
docker compose -f docker-compose.memory.yml up -d
```

### 8. Restart the gateway (host, via launchd)

```sh
openclaw gateway restart
```

**CRITICAL: The gateway runs on the HOST via launchd, NOT in Docker.**
Do NOT run `docker compose -f docker-compose.yml up -d` or `docker build -t openclaw:local .` for the gateway.
Docker is only used for Mattermost and the memory stack. Running the gateway in Docker breaks agent access to host tools (gh, git, etc.).

### 9. Restart the consumer (Reactor + workflow engine)

```sh
launchctl kickstart -k gui/501/com.openclaw.consumer
```

The consumer runs the Reactor (60s PR polling loop), the workflow watchdog, and the step executor. It must be restarted after a rebuild so it picks up the new code. Wait 5 seconds, then verify:

```sh
tail -5 ~/.openclaw/runtime/logs/runtime.log
```

You should see "Reactor started — polling every 60s" and "Consumer started". If not, check for PID lock issues (`rm -f ~/.openclaw/runtime/consumer.pid` and retry).

### 10. Verify everything

Run all checks and report results in a table:

| Check               | Command                                                                  | Expected                                                            |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Gateway             | `openclaw channels status --probe`                                       | "Gateway reachable"                                                 |
| Mattermost channels | same output                                                              | All configured bots show "connected" + "works"                      |
| CRONs               | `openclaw cron list`                                                     | All jobs listed with schedules                                      |
| mem0                | `curl -s http://localhost:8420/health`                                   | `{"status":"ok"}`                                                   |
| Reactor             | `grep "Reactor started" ~/.openclaw/runtime/logs/runtime.log \| tail -1` | "Reactor started — polling every 60s" (timestamp within last 2 min) |

If any check fails, investigate and fix before reporting success.

### 11. Push

```sh
git push origin main
```

## Notes

- **The gateway runs on the HOST via launchd (`ai.openclaw.gateway`), NOT in Docker.** Never containerize it — agents need direct access to host tools (gh, git, node, etc.).
- Do NOT run `docker build -t openclaw:local .` or `docker compose -f docker-compose.yml up -d` — these would start a competing Docker gateway that breaks everything.
- Docker is ONLY for: Mattermost (`docker-compose` in `/Users/renas/Projects/mattermost/deploy`) and the memory stack (`docker-compose.memory.yml`).
- Mattermost lives in a separate repo at `/Users/renas/Projects/mattermost/deploy`.
- mem0 is exposed on port 8420 (mapped from container port 8000).
- If `pnpm build` is skipped after a merge, the mattermost plugin and other extensions WILL break at runtime due to stale dist output. Never skip the build step.
