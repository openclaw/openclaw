# Status Playbook -- Real-Time Decoder Ring

When the terminal screams, read this before touching anything.

| Signal / Log                                             | What it really means                                                                                                  | What to do                                                                                                                                                                                                                          | Avg. duration                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `health: starting`                                       | Gateway booting, waiting for services (db, browser bridge, sandbox). Common right after onboarding or Docker restart. | Wait up to 120 s (Apple Silicon) / 60 s (Intel & Linux). If it exceeds that, run `openclaw logs --limit 50` and check for config errors.                                                                                            | 30-120 s                                                                                                                            |
| `gateway restarting` (loop)                              | Config validation failed or a fatal crash occurred; supervisor keeps trying.                                          | Run `openclaw logs --limit 200                                                                                                                                                                                                      | less`to find the first error. Most often caused by malformed`openclaw.json`. Revert the last change or run `openclaw doctor --fix`. | Until config is fixed |
| `anthropic: No API key found` (subagent)                 | Child agent filesystem doesn't have your provider creds.                                                              | Copy or symlink `~/.openclaw/agents/main/agent/auth-profiles.json` into the subagent dir before spawning, or export provider env vars.                                                                                              | Immediate once file exists                                                                                                          |
| **Subagent identity isolation**                          | Same error keeps reappearing even after copying keys; you cloned/created multiple subagent dirs with unique IDs.      | Run `ls ~/.openclaw/agents` to list actual agent IDs, then `rsync -a ~/.openclaw/agents/main/agent/auth-profiles.json ~/.openclaw/agents/<target>/agent/`. Verify with `jq '.profiles                                               | keys'` on both files.                                                                                                               | 1-2 min               |
| `docker compose: command not found` inside `~/.openclaw` | You're in the data directory, not the repo with `docker-compose.yml`.                                                 | `cd ~/openclaw` (or wherever you cloned the repo) and rerun the compose command; leave `~/.openclaw` for config/state only.                                                                                                         | Instant                                                                                                                             |
| `playwright install chromium` errors inside Docker       | Container lacks browsers/system deps.                                                                                 | Rebuild image with `OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg ..."` or run install inside a persisted `/home/node`.                                                                                                                      | Rebuild time                                                                                                                        |
| `gateway pairing required (1008)` in Control UI          | Browser not paired with the gateway yet.                                                                              | Run `openclaw dashboard --no-open`, copy the link, approve the device from CLI or Control UI > Devices.                                                                                                                             | 1-2 min                                                                                                                             |
| **Control UI blank screen after token**                  | Browser keeps showing a blank panel even after token entry; stale localStorage or Service Worker cache.               | Chrome: DevTools -> Application -> Clear storage (incl. SW), then run `localStorage.setItem('gatewayToken', 'PASTE_TOKEN')`, refresh, and approve the device again. Safari: `Develop -> Empty Caches` before reinjecting the token. | 2-3 min                                                                                                                             |
| `pnpm ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` during install | Lockfile or dependency step failed, often due to stale pnpm version.                                                  | Run `corepack enable pnpm@9 && pnpm env use --global 9`, then rerun `pnpm install`. On macOS/Linux, ensure Xcode CLT / build-essential are present.                                                                                 | 2-3 min                                                                                                                             |
| `EADDRINUSE 18789`                                       | Another gateway instance is already bound to Control UI port.                                                         | Either stop the old daemon (`openclaw stop`) or set `gateway.portControl` in `openclaw.json` before restarting.                                                                                                                     | Instant after stop                                                                                                                  |
| `sandbox docker socket permission denied`                | Docker socket not mounted/accessible for sandbox.                                                                     | macOS: enable "Use Virtualization framework" in Docker Desktop + share `/var/run/docker.sock`. Linux: add user to `docker` group or set `OPENCLAW_DOCKER_SOCKET`.                                                                   | Depends on restart                                                                                                                  |

## Hardcore logbook (field captures)

### Connection Refused loop

```
[2026-03-05T01:32:11.021Z] control-ui WARN gateway: connect ECONNREFUSED 127.0.0.1:18789
curl: (7) Failed to connect to 127.0.0.1 port 18789: Connection refused
openclaw dashboard --no-open
  ->  Error: HTTP 599 (connection refused)
```

- **Diagnosis**

  ```bash
  curl -vk http://127.0.0.1:18789/health || true
  systemctl --user status openclaw-gateway
  ```

  If `curl` still reports ECONNREFUSED, the gateway never bound; check whether Docker is still building or if the daemon crashed (see `journalctl --user -u openclaw-gateway`).

### Token mismatch spiral

```
[2026-03-05T01:34:55.886Z] control-ui WARN websocket: disconnected (1008): token mismatch
[2026-03-05T01:34:56.112Z] control-ui INFO reconnect scheduled in 5s
browser console: WebSocket close code 1008 -- token mismatch / expired
```

- **Diagnosis**

  ```bash
  curl -sSf http://127.0.0.1:18789/api/ping \
       -H "X-OpenClaw-Token: $(cat ~/.openclaw/token)"
  ```

  If the ping succeeds, your token is valid--clear browser storage and reinject (`localStorage.setItem('gatewayToken', '...')`). If curl fails with 401, regenerate via `openclaw dashboard --no-open`.

## Quick scripts

- **Check where compose files live**

  ```bash
  ls docker-compose*.yml
  # If empty, you're not in the repo root.
  ```

- **Dry-run config before hot reload** (manual stopgap until the automation tool ships)

  ```bash
  jq empty ~/.openclaw/openclaw.json && openclaw doctor --non-interactive
  ```

- **Auth profile sync sanity check**

  ```bash
  diff -u ~/.openclaw/agents/main/agent/auth-profiles.json \
         ~/.openclaw/agents/*/agent/auth-profiles.json || true
  ```

_Add new rows whenever you decode a scary message. The goal is zero guesswork._
