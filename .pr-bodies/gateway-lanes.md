Implements #181368

## What Problem This Solves

Command-lane busyness already exists as Gateway RPC `diagnostics.lanes` (`operator.read`), and `openclaw gateway stability` already exposes `diagnostics.stability` as a native verb. Operators investigating saturation, group-budget blocking, or main/subagent/cron pressure must still hand-write `gateway call diagnostics.lanes` JSON. `gateway diagnostics export` is a different surface (support zip), not a live lane snapshot.

## User Impact

User impact: `openclaw gateway lanes` exposes the existing admin RPC as a first-class CLI verb with the same auth/error class as sibling Gateway query commands. Operators get active/queued/maxConcurrent (plus blockedBy / group / worker-pool summaries) without composing RPC JSON.

## Why This Change Was Made

Thin Alix-style CLI adapter only: register `gateway lanes`, forward empty params to existing `diagnostics.lanes`, print Gateway JSON or a short human summary, and document next to `gateway stability`. No new Gateway methods, schema, permissions, or lane scheduling behavior.

## Evidence

- Changed: `src/cli/gateway-cli/register.ts`, `src/cli/command-catalog.ts`, colocated registration tests, `docs/cli/gateway/query.md` (+ TOC / CLI index)
- Unit/registration: `node scripts/run-vitest.mjs src/cli/gateway-cli/register.option-collisions.test.ts src/cli/gateway-cli.coverage.test.ts` — **49 passed**
- Packaged CLI proof below (Node 24.22.1, isolated `OPENCLAW_STATE_DIR`, local Gateway with token auth)

## Real behavior proof

### Behavior or issue addressed

Operators need native `openclaw gateway lanes` that calls existing `diagnostics.lanes` and returns `ts` + `lanes` (+ dynamic/worker summaries); missing Gateway/auth must fail like sibling admin RPC verbs.

### Canonical reachability path

Packaged `openclaw gateway lanes` → `callGatewayReadOnlyCli("diagnostics.lanes", …, {})` → existing Gateway handler (`getCommandLaneDiagnostics` + `getTrackedWorkerPoolSnapshot`).

### Shared helper / provider constraint check

Reuses `callGatewayReadOnlyCli` / `printGatewayResult` and existing `diagnostics.lanes` owner. No new query engine, schema, permissions, or concurrency policy.

### Real environment tested

Packaged CLI (`node openclaw.mjs`) after `qaRuntime` build on Node 24.22.1; temporary `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`; local `openclaw gateway run` with token auth.

### Exact steps or command run after this patch

```bash
export PATH="/home/box/.local/node-v24.22.1-linux-x64/bin:$PATH"
export OPENCLAW_STATE_DIR=$(mktemp -d)
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
# config: gateway.mode=local, auth.token, port
node openclaw.mjs gateway run --port 18793 &
node openclaw.mjs gateway lanes --url ws://127.0.0.1:18793 --token "$TOKEN" --json
node openclaw.mjs gateway call diagnostics.lanes --url ws://127.0.0.1:18793 --token "$TOKEN" --json
node openclaw.mjs gateway lanes --url ws://127.0.0.1:1 --token "$TOKEN" --timeout 2000 --json  # exit 1
```

### Evidence before fix (base RED)

```text
# on packaged CLI without this commit:
# openclaw gateway lanes --json
OpenClaw gateway has no command "lanes".
Try: openclaw gateway --help
{
  "ok": false,
  "error": {
    "type": "cli_error",
    "message": "OpenClaw gateway has no command \"lanes\".\nTry: openclaw gateway --help\nDocs: https://docs.openclaw.ai/cli"
  }
}
```

### Evidence after fix

```text
# gateway --help lists lanes
  lanes                     Fetch Gateway command-lane busyness diagnostics

# openclaw gateway lanes --json  (exit 0)
{
  "ts": 1792733169458,
  "lanes": [
    { "lane": "main", "queuedCount": 0, "activeCount": 0, "maxConcurrent": 32, "draining": false, "generation": 0, "blockedBy": null },
    { "lane": "subagent", "queuedCount": 0, "activeCount": 0, "maxConcurrent": 8, "concurrencyScope": "session", "saturatedLaneCount": 0, "...": "..." }
  ],
  "dynamic": null,
  "workerCount": 17,
  "workerPoolCount": 9,
  "workerPools": [ { "poolId": 2, "script": "openclaw-state-read.worker.js", "workerCount": 2 }, "..." ]
}

# human output
Gateway Lanes
Ts: …
main: active=0 · queued=0 · max=32
subagent: active=0 · queued=0 · max=8 · scope=session
Workers: count=17 · pools=9

# without Gateway (exit 1)
{
  "ok": false,
  "error": {
    "type": "gateway_transport_error",
    "kind": "closed",
    "message": "Gateway not reachable at ws://127.0.0.1:1 (ECONNREFUSED)."
  }
}
```

### What was not tested

Live saturation under load (group-budget / blockedBy paths); Control UI System busyness overlay parity beyond RPC payload shape.
