# Durable Runtime Foundation PR Proof - 2026-07-01

## Scope

This proof covers the durable runtime foundation slice only. It intentionally
does not include Workboard UI, Workboard tools, Work module behavior, or Task
Flow projection adapters.

The PR2 foundation slice includes:

- `durable_runtime_*` tables in the shared OpenClaw state database;
- SQLite store lifecycle, schema version checks, private-mode state hardening,
  and Kysely generated type alignment;
- runtime run, step, event, ref, link, timer, and signal primitives;
- local-first claim/release, heartbeat, recovery, and bounded worker helpers;
- read-only CLI/Gateway inspection surfaces;
- generic coordination projection with unsupported write controls disabled.

## Review Boundary

This branch depends on the RFC v2 docs branch for the architecture decision. It
is intentionally a local-first, opt-in runtime substrate:

- feature flag: `OPENCLAW_DURABLE_RUNTIME`;
- default behavior: disabled;
- storage home: shared `state/openclaw.sqlite`;
- initial API posture: read-only inspection and recovery markers;
- non-goal: automatic retry/resume policy or product-specific task/card UI.

## Validation Checklist

Focused validation observed on the PR2 branch:

- Disabled CLI mutation guard:
  - Command:
    `OPENCLAW_STATE_DIR=<temp> node --import tsx --input-type=module -e 'import { durableCommand } from "./src/commands/durable.ts"; await durableCommand({ action: "stats", env: process.env }, { log: console.log, error: console.error, exit: (code) => { process.exitCode = code; } });'`
  - Output:
    `Durable runtime is disabled. Set OPENCLAW_DURABLE_RUNTIME=1 to inspect durable runtime state.`
  - Follow-up filesystem check under `<temp>` printed no files, proving the
    disabled command path did not create `state/openclaw.sqlite`, WAL, or SHM
    files.
- Enabled CLI inspection proof:
  - Command:
    `OPENCLAW_STATE_DIR=<temp> OPENCLAW_DURABLE_RUNTIME=1 node --import tsx --input-type=module -e 'import { durableCommand } from "./src/commands/durable.ts"; await durableCommand({ action: "stats", env: process.env }, { log: console.log, error: console.error, exit: (code) => { process.exitCode = code; } });'`
  - Output:
    `Durable runtime store: <temp>/state/openclaw.sqlite`
    `runs=0 open=0 steps=0 events=0`
- Gateway durable coordination proof:
  - Disabled command:
    `OPENCLAW_STATE_DIR=<temp> node --import tsx --input-type=module -e 'import { durableHandlers } from "./src/gateway/server-methods/durable.ts"; durableHandlers["durable.coordination.get"]({ params: { runtimeRunId: "run_missing" }, respond: (ok, result, error) => console.log(JSON.stringify({ ok, code: error?.code, message: error?.message, hasResult: Boolean(result) })) });'`
  - Disabled output:
    `{"ok":false,"code":"INVALID_REQUEST","message":"Durable runtime is disabled.","hasResult":false}`
  - Follow-up filesystem check under `<temp>` printed no files.
  - Enabled output after creating `run_gateway_proof` in the same shared state
    store:
    `{"ok":true,"runtimeRunId":"run_gateway_proof"}`
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable`
  - 14 files, 53 tests passed.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.commands.config.ts src/commands/durable.test.ts`
  - 1 file, 2 tests passed.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable/store-factory.test.ts src/durable/sqlite-store.test.ts`
  - 2 files, 11 tests passed.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts src/gateway/server-methods/durable.test.ts`
  - 2 files, 4 tests passed.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/state/openclaw-state-db.test.ts src/state/openclaw-agent-db.test.ts src/durable/sqlite-store.test.ts src/durable/recovery.test.ts`
  - 4 files, 47 tests passed, 2 skipped.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable/sqlite-store.test.ts src/durable/recovery.test.ts src/durable/coordination-projection.test.ts src/durable/fan-in.test.ts src/durable/executor.test.ts src/durable/subagent.test.ts`
  - covered the exact durable matrix requested on the previous durable-core PR.
  - 6 files, 36 tests passed on PR2.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/state/openclaw-state-db.test.ts src/state/openclaw-state-db.permissions.test.ts src/state/sqlite-query-plan.test.ts`
  - 3 files, 26 tests passed, 1 skipped on PR2.
- `node scripts/generate-kysely-types.mjs --verify`
  - passed.
- `node scripts/check-kysely-guardrails.mjs`
  - passed with `Kysely guardrails OK`.
- `./node_modules/.bin/oxfmt --check --threads=1 <changed durable/state/gateway files>`
  - passed on 47 PR2 durable/state/gateway files.
- `git diff --check`
  - passed.

Full stack typecheck proof is recorded on the stacked PR3 branch, which includes
this PR2 foundation plus agent/session wiring.

## Known Follow-Ups

- PR3 wires this foundation into agent/session/subagent runtime paths.
- Work module, Workboard UI, Task Flow projection, retention/compaction, and
  write controls remain follow-up PRs.
