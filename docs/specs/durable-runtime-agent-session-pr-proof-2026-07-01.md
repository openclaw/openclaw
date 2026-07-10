# Durable Runtime Agent/Session Wiring PR Proof - 2026-07-01

## Scope

This proof covers the PR3 agent/session wiring slice stacked on the durable
runtime foundation PR.

The PR3 slice includes:

- gateway `chat.send` and `agent.run` correlation with durable runtime context
  refs;
- user-turn transcript propagation for durable context refs;
- embedded-agent yield progress for resumable parent turns;
- subagent child-run mirroring and parent fan-in association;
- task completion contract metadata needed for durable parent/child lifecycle;
- status-notice display metadata for durable/yield progress.

This slice does not include Work module, Workboard UI/tools, Task Flow
projection adapters, retention/compaction, or write controls.

## Dependency

This PR depends on the durable runtime foundation branch. Review PR2 first for
the `durable_runtime_*` schema, store, recovery, CLI, and read-only Gateway
inspection APIs.

## Validation Snapshot

Focused validation run before opening the PR:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts src/gateway/server-methods/durable.test.ts src/gateway/context-refs.test.ts src/gateway/server-methods/server-methods.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/sessions-spawn-tool.test.ts src/agents/tools/gateway-tool.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/agents/subagent-registry-lifecycle.test.ts src/agents/system-prompt.test.ts src/agents/embedded-agent-runner/run.empty-error-retry.test.ts src/tasks/task-completion-contract.test.ts src/tasks/task-executor-policy.test.ts src/sessions/user-turn-transcript.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable/fan-in.test.ts src/durable/subagent.test.ts src/durable/agent-turn.test.ts
```

Observed results:

- gateway/context/server-methods shard: 6 files, 176 tests passed;
- agent tools shard: 2 files, 67 tests passed;
- agent/session/task policy shard: 1 file, 27 tests passed;
- durable fan-in/subagent/agent-turn shard: 3 files, 14 tests passed.
- exact durable matrix from the previous durable-core PR:
  - `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable/sqlite-store.test.ts src/durable/recovery.test.ts src/durable/coordination-projection.test.ts src/durable/fan-in.test.ts src/durable/executor.test.ts src/durable/subagent.test.ts`
  - 6 files, 36 tests passed.
- exact Gateway durable matrix:
  - `node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts src/gateway/server-methods/durable.test.ts`
  - 2 files, 4 tests passed.
  - Covers enabled projection and disabled read paths that do not create durable
    SQLite state.
- exact shared-state permissions/query-plan matrix:
  - `node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/state/openclaw-state-db.test.ts src/state/openclaw-state-db.permissions.test.ts src/state/sqlite-query-plan.test.ts`
  - 3 files, 26 tests passed, 1 skipped.
- subagent lifecycle compatibility:
  - `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents.config.ts src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts`
  - 1 file, 8 tests passed.
- redaction/bounded metadata regression:
  - covered by `src/durable/subagent.test.ts`.
  - verifies `taskHash` is stored and raw `task` is not stored on child run or
    parent link metadata.

## Typecheck and Schema Proof

Additional validation run on the stacked PR3 branch:

- `node scripts/generate-kysely-types.mjs --verify`
  - passed.
- `node scripts/check-kysely-guardrails.mjs`
  - passed with `Kysely guardrails OK`.
- `git diff --check`
  - passed.
- `npm run tsgo:core`
  - passed.
- `npm run tsgo:core:test`
  - passed.
- `OPENCLAW_LOCAL_CHECK=0 node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core-test.tsbuildinfo`
  - passed.
- `npm run tsgo:prod`
  - passed after `pnpm tsgo:core && pnpm tsgo:extensions`.
- `./node_modules/.bin/oxfmt --check --threads=1 <changed durable/state/gateway files>`
  - passed on 62 changed PR3 durable/state/gateway/session/task/protocol files.
- `node --import tsx /private/tmp/openclaw-durable-runtime-proof.mts`
  - passed against an isolated temporary SQLite database.
  - created 3 runtime runs, 2 timeline events, and 1 fan-in step.
  - projected 2 child runs with 1 succeeded, 1 failed, 2 terminal, and 0 open.
  - projected reportable `lost` recovery state for restart/reconciliation proof.

## Local Build Note

`env CI=true npm run build` was attempted locally. The initial non-CI run stopped
because pnpm refused a non-TTY module purge. With `CI=true`, dependency
installation and bundled plugin assets completed, then the root `tsdown` build
emitted only heartbeat lines for more than ten minutes and was manually
interrupted. This is not recorded as a passing build proof; CI or a maintainer
machine should still run the full build before merge.

## Remaining Proof To Add Before PR Submission

- optional maintainer-machine `npm run build` or CI build confirmation, because
  the local full build was blocked by the root `tsdown` bundling phase.
