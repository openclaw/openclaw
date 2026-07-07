# Durable Runtime PR Proof - 2026-07-01

## Scope

This proof covers the native durable runtime naming and first-class runtime
identity pass:

- durable store/API/schema naming uses `runtime_run_id`, `runtimeRunId`,
  `operation_kind`, and `operationKind`;
- the public runtime feature flag is `OPENCLAW_DURABLE_RUNTIME`;
- durable runs carry first-class `workUnitId` and `reportRouteId` fields for
  task/session coordination surfaces;
- gateway `chat.send` durable intake records work-unit context when a
  `work_unit` context reference is present;
- coordination projections surface `workUnitId` and `reportRouteId` for
  durable-runtime consumers and operator clients.

This private review pass intentionally excludes Workboard plugin, Workboard UI,
and TaskFlow product-level proof. See
`docs/specs/durable-core-private-review-plan-2026-07-07.md` for the
five-PR durable-core-only stack plan.

## Verification

Commands run from the OpenClaw worktree:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable src/gateway/server-methods/durable.test.ts src/gateway/context-refs.test.ts
pnpm tsgo:core
pnpm tsgo:core:test
pnpm lint:kysely
git diff --check
```

Results:

Latest private durable-core-only rerun on 2026-07-07 23:09 GMT+7:

- durable/gateway/context-ref shard: passed, 55 tests across 15 files;
- `pnpm tsgo:core`: passed;
- `pnpm tsgo:core:test`: passed;
- `pnpm lint:kysely`: passed with `Kysely guardrails OK`;
- `git diff --check`: passed.

The prior `sessionEffects` typecheck blocker is fixed by carrying the existing
embedded-agent internal session-effect option on `RunEmbeddedAgentParams`.

Earlier Workboard extension shards and full build were intentionally removed
from this proof narrative because they are outside durable-core private review
scope.

## Local Runtime Smoke

OpenClaw A was applied to the same worktree and restarted with:

```bash
OPENCLAW_DURABLE_RUNTIME=1
```

Smoke evidence:

- `http://127.0.0.1:37101/health` returned `{"ok":true,"status":"live"}`;
- `openclaw durable stats --json` returned schema version `1` and durable
  runtime rows in the local SQLite state database;
- `openclaw durable runs --json` returned `runtimeRunId` and `operationKind`
  fields for `openclaw.gateway.startup` runs;
- gateway startup log recorded:
  - `[durable/runtimes] recorded durable gateway startup`;
  - `[durable/recovery] started durable recovery worker`;
- Discord provider for the configured local agent resolved successfully.

Known local-environment warnings were not caused by this change:

- Telegram local token is unauthorized in the test instance;
- legacy config-health migration conflict remains in local state;
- these are local state/config issues and are outside this runtime PR scope.

## Public Fork Update Readiness

The private branch was pushed first. The public fork branch was checked with
dry-run only, so the upstream-facing PR branch is ready to update but was not
pushed as part of this proof pass. The final private branch may include a
proof-only documentation commit after the runtime delta shown below.

```bash
git push --dry-run fork codex/openclaw-durable-batch-f-workboard-chat
```

Result:

```text
To https://github.com/mjnkao/openclaw.git
   907770da96..c683be688e  codex/openclaw-durable-batch-f-workboard-chat -> codex/openclaw-durable-batch-f-workboard-chat
```

Additional PR-delta checks:

```bash
git diff --check fork/codex/openclaw-durable-batch-f-workboard-chat..HEAD
git log --oneline fork/codex/openclaw-durable-batch-f-workboard-chat..HEAD
```

The whitespace check passed. The public-ready runtime delta contains these
commits before the proof-only documentation commit:

```text
c683be688e Rename durable core to runtime primitives
e3e220fa02 Add workboard archive tool and chat session controls
9ed2d28fd9 Refine workboard embedded chat panel
732e049bfc snapshot openclaw-x durable coordination core
```
