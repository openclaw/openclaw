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
  TaskFlow, Workboard, and operator clients;
- Workboard plugin metadata declares the `workboard_archive` tool contract.

## Verification

Commands run from the OpenClaw worktree:

```bash
npm test -- --run extensions/workboard/src/tools.test.ts extensions/workboard/doctor-contract-api.test.ts src/durable src/gateway/server-methods/durable.test.ts src/gateway/context-refs.test.ts
npm run tsgo:core
npm run tsgo:core:test
npm run build
git diff --check
```

Results:

- durable unit shard: 14 files, 45 tests passed;
- gateway shard: 6 files, 20 tests passed;
- workboard extension shard: 2 files, 13 tests passed;
- `tsgo:core`: passed;
- `tsgo:core:test`: passed;
- `npm run build`: passed, including `tsdown`, plugin SDK export checks, plugin
  asset copy, and control UI production build;
- `git diff --check`: passed.

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
