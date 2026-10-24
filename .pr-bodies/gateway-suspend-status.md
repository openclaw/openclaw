Implements #181354

## What Problem This Solves

Cooperative host suspension already exposes `gateway.suspend.status` (`operator.read`) for polling an issued lease (`running` / `draining` / `ready`, blockers, expiry, optional lifecycle), but the native CLI only wraps prepare (`openclaw gateway suspend`) and resume (`openclaw gateway resume`). Operators who need a one-shot poll of an existing `suspensionId` (drain progress, shutdown observation, or “is this lease still held?”) must hand-write `gateway call` JSON. `gateway suspend --wait` only retries **prepare** and does not replace status polling.

## User Impact

User impact: `openclaw gateway suspend status <suspensionId>` exposes the existing `gateway.suspend.status` RPC as a first-class CLI verb with the same auth/error class as sibling Gateway-backed commands. Operators get lease status JSON (and optional lifecycle fields via `--include-lifecycle`) without composing RPC params.

## Why This Change Was Made

Thin Alix-style CLI adapter only: register `gateway suspend status`, forward `{ suspensionId, includeLifecycle? }` to the existing Gateway method, print the Gateway payload, and document next to suspend / resume. No new Gateway methods, schema, permissions, or suspension behavior. Nested `--json`/`--port` inherit from the parent `suspend` command (same pattern as other Gateway option inheritance).

## Evidence

- Changed: `src/cli/gateway-cli/suspend-cli.ts`, `src/cli/gateway-cli/register.ts`, `src/cli/gateway-cli/gateway-action.ts`, `src/cli/command-catalog.ts`, colocated tests, `docs/cli/gateway/query.md`, `docs/cli/gateway.md`
- Unit/registration: `node scripts/run-vitest.mjs src/cli/gateway-cli/suspend-cli.test.ts src/cli/gateway-cli/register.option-collisions.test.ts` — **38 passed**
- Packaged CLI proof below (Node 24.22.1, isolated `OPENCLAW_STATE_DIR`, local Gateway with token auth)

## Real behavior proof

### Behavior or issue addressed

Operators need native `openclaw gateway suspend status <suspensionId>` that calls existing `gateway.suspend.status` and returns `running` / `ready` / `draining` JSON; missing Gateway must fail like sibling RPC verbs.

### Canonical reachability path

Packaged `openclaw gateway suspend status` → `runGatewaySuspendStatus` → `callGatewayFromCliWithTransport("gateway.suspend.status", …, { suspensionId, includeLifecycle? })` → existing Gateway handler (`getGatewaySuspendStatus`).

### Shared helper / provider constraint check

Reuses `callGatewayFromCliWithTransport` and existing `gateway.suspend.status` owner. No new query engine, schema, permissions, or suspension lease semantics. Explicitly not #180736 (persistent maintenance pause).

### Real environment tested

Packaged CLI (`node openclaw.mjs`) after `qaRuntime` build on Node 24.22.1; temporary `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`; local `openclaw gateway run` with token auth.

### Exact steps or command run after this patch

```bash
export PATH="/home/box/.local/node-v24.22.1-linux-x64/bin:$PATH"
export OPENCLAW_STATE_DIR=$(mktemp -d)
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
# config: gateway.mode=local, auth.token, bind=loopback
node openclaw.mjs gateway run --port 18794 --token "$TOKEN" &
READY=$(node openclaw.mjs gateway suspend --url ws://127.0.0.1:18794 --token "$TOKEN" --json)
ID=$(printf '%s' "$READY" | jq -r .suspensionId)
node openclaw.mjs gateway suspend status "$ID" --url ws://127.0.0.1:18794 --token "$TOKEN" --json
node openclaw.mjs gateway suspend status "$ID" --include-lifecycle --url ws://127.0.0.1:18794 --token "$TOKEN" --json
node openclaw.mjs gateway resume "$ID" --url ws://127.0.0.1:18794 --token "$TOKEN" --json
node openclaw.mjs gateway suspend status "$ID" --url ws://127.0.0.1:18794 --token "$TOKEN" --json
# parity: openclaw gateway call gateway.suspend.status --params "{\"suspensionId\":\"$ID\"}" --json
# negative: openclaw gateway suspend status "$ID" --url ws://127.0.0.1:1 --token "$TOKEN" --timeout 2000 --json  → exit 1
```

### Evidence after fix

```text
# openclaw gateway suspend --help
Commands:
  status                 Poll an existing cooperative Gateway suspension lease

# openclaw gateway suspend --json  (exit 0)
{
  "status": "ready",
  "suspensionId": "b565f0e4-2f49-44eb-b5d3-10b0115f08b3",
  "expiresAtMs": 1792732682159,
  "activeCount": 0,
  "blockers": [],
  "writeCustody": [],
  "requestId": "cli-06883a74"
}

# openclaw gateway suspend status <id> --json  (exit 0)
{
  "status": "ready",
  "expiresAtMs": 1792732682159,
  "writeCustody": []
}

# openclaw gateway suspend status <id> --include-lifecycle --json  (exit 0)
{
  "status": "ready",
  "ownerId": "cli-06883a74",
  "expiresAtMs": 1792732682159,
  "writeCustody": []
}

# after resume → status
{ "status": "running" }

# parity gateway call
{ "status": "running" }

# unreachable Gateway (exit 1)
{
  "ok": false,
  "error": {
    "type": "gateway_transport_error",
    "kind": "closed",
    "message": "Gateway not reachable at ws://127.0.0.1:1 (ECONNREFUSED).",
    "reason": "connect ECONNREFUSED 127.0.0.1:1"
  },
  "gateway": {
    "url": "ws://127.0.0.1:1",
    "urlSource": "cli --url"
  }
}
```

### Evidence before fix (base RED)

```text
# on upstream/main packaged CLI before this commit:
# openclaw gateway suspend --help
Usage: openclaw gateway suspend [options]
# (no Commands / status subcommand)

# openclaw gateway suspend status anything --json
Too many arguments for this command.
Try: openclaw gateway suspend --help
{
  "ok": false,
  "error": {
    "type": "cli_error",
    "message": "Too many arguments for this command.\nTry: openclaw gateway suspend --help"
  }
}
```

### What was not tested

Live drain/shutdown phase (`status: "draining"`) under committed handoff; auth scope matrix beyond token operator success / unreachable Gateway failure; Control UI suspension indicator path.

## AI assistance

AI-assisted implementation and proof packaging; human-authored issue scope (#181354).
