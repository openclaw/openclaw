# OpenClaw Continuity Bridge

This package is the authoritative tracked source for the OpenClaw continuity bridge runtime.

## Why this lives here

- The bridge is OpenClaw-facing by contract: it binds the fixed caller identity `vairys-openclaw`, exposes the OpenClaw parity allowlist, and serves the OpenClaw continuity runtime.
- `Projects/openclaw` is the clean tracked repo candidate for this lane.
- `Projects/airya` contains adjacent HQ code, but the current root checkout is carrying unrelated salvage work and is not a safe closeout surface for Task 84.

## What remains live

The live runtime still executes from `~/.airya/mcp` via `run-continuity-bridge.sh`. That directory is now treated as a derived sidecar target, not the only source location.

## Sync and build path

1. Make changes here first.
2. Run proof here:
   - `npm run build`
   - `npx vitest run __tests__/engine-tools.test.ts __tests__/proxy.test.ts __tests__/openclaw-continuity-bridge.test.ts`
3. Sync to the live sidecar:
   - `npm run sync:sidecar`
4. If the live sidecar needs a refreshed runtime artifact:
   - `cd ~/.airya/mcp && npm run build`

The sync step copies only the bridge-owned runtime files. It does not overwrite the shared sidecar `package.json` or `tsconfig*` files, because `~/.airya/mcp` also hosts other MCP surfaces outside this lane.

## External dependency

`memory-read-tools.ts` intentionally keeps the existing runtime contract: memory tool calls resolve the shared memory retrieval module from the AiRYA checkout at `~/Projects/airya` unless `AIRYA_REPO_ROOT` overrides that path. The bridge package can now load and test without that sibling checkout, but live memory tool invocations still require the AiRYA source or dist module to be present.
