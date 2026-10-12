## What Problem This Solves

Fixes: `openclaw config set agents.defaults.heartbeat.every ''` (or whitespace) persists `every: ""`, which `resolveHeartbeatIntervalMs` treats as disabled (same as `"0m"`), silently turning off heartbeat instead of rejecting the typo.

## User Impact

User impact: blank `heartbeat.every` is rejected before save; existing cadence is preserved. Explicit `"0m"` still disables heartbeat; nonempty durations like `"30m"` are unchanged.

## Why This Change Was Made

`HeartbeatSchema` only ran `parseDurationMs` when `val.every` was truthy, so `""` skipped validation and was written. Runtime then `normalizeOptionalString("")` → null interval. The fix rejects blank/whitespace `every` in schema superRefine and keeps `"0m"` as the explicit disable.

## Evidence

- Changed: `src/config/zod-schema.agent-runtime.ts`; colocated test in `zod-schema.agent-defaults.test.ts`
- Packaged CLI: base RED (`config set … every ''` → rc=0, disk `every:""`) / head GREEN (rc=1, validation message, disk unchanged `"30m"`); `"0m"` still accepted
- Unit: rejects blank / whitespace; accepts `0m` and `30m`
- Dedup: no open PR on blank `heartbeat.every` rejection

## Real behavior proof

### Behavior or issue addressed

Blank `agents.defaults.heartbeat.every` must not disable heartbeat; `"0m"` remains the explicit disable; `"30m"` remains valid.

### Canonical reachability path

Packaged `openclaw config set agents.defaults.heartbeat.every ''` → config mutation validation → `HeartbeatSchema.superRefine` → declined write → disk unchanged.

### Shared helper / provider constraint check

Schema-only; `resolveHeartbeatIntervalMs` unchanged. `"0m"` still yields a null interval by design.

### Real environment tested

CLI via `node --import ./scripts/tsx.mjs src/entry.ts` with temporary `OPENCLAW_STATE_DIR`.

### Exact steps or command run after this patch

```bash
export OPENCLAW_STATE_DIR=$(mktemp -d) OPENCLAW_CONFIG_PATH=$OPENCLAW_STATE_DIR/openclaw.json
printf '%s\n' '{"agents":{"defaults":{"heartbeat":{"every":"30m"}}}}' > "$OPENCLAW_CONFIG_PATH"
CLI=(node --import ./scripts/tsx.mjs src/entry.ts)
"${CLI[@]}" config set agents.defaults.heartbeat.every ''; echo blank_rc=$?
"${CLI[@]}" config get agents.defaults.heartbeat.every --json
"${CLI[@]}" config set agents.defaults.heartbeat.every '0m'; echo zero_rc=$?
"${CLI[@]}" config set agents.defaults.heartbeat.every '30m'
"${CLI[@]}" config set agents.defaults.heartbeat.every '  '; echo ws_rc=$?
"${CLI[@]}" config get agents.defaults.heartbeat.every --json
```

### Evidence after fix

```text
blank_rc=1
Config validation failed: agents.defaults.heartbeat.every: must not be blank (use "0m" to disable heartbeat)
Config change declined. No settings were saved.
readback: "30m"
zero_rc=0
readback: "0m"
ws_rc=1
(same blank rejection; after reset to 30m) readback: "30m"
```
