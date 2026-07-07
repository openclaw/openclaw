# Durable Core 5-PR Private Body Templates - 2026-07-07

These templates are for private review only. Do not push or open public PRs from this preparation pass.

## PR 1 - Durable runtime foundation

### Summary

- Add durable runtime foundation modules for runtime IDs, intake envelopes, execution, recovery, worker startup, and persistence.
- Add SQLite-backed durable store and factory with tests.
- Register durable gateway/CLI surfaces behind `OPENCLAW_DURABLE_RUNTIME`.

### Scope

Durable runtime core only. No Workboard UI/plugin changes.

### Test plan

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable src/gateway/server-methods/durable.test.ts
pnpm tsgo:core
```

### Reviewer notes

Please focus on lifecycle boundaries, persistence semantics, feature-flag behavior, and non-durable default behavior.

## PR 2 - Agent/session runtime wiring

### Summary

- Propagate durable runtime context through agent turns, subagent lifecycle, gateway tools, session transcripts, and gateway chat/agent methods.
- Add context-ref support for durable work-unit references.
- Extend protocol schemas for runtime context where needed.

### Scope

Agent/session/gateway integration for durable core. No Workboard plugin shard or TaskFlow product behavior.

### Test plan

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/agents/embedded-agent-runner/run.empty-error-retry.test.ts src/agents/subagent-registry-lifecycle.test.ts src/agents/system-prompt.test.ts src/agents/tools/gateway-tool.test.ts src/gateway/context-refs.test.ts src/gateway/server-methods/server-methods.test.ts packages/gateway-protocol/src/index.test.ts
pnpm tsgo:core:test
```

### Reviewer notes

Please focus on context propagation, transcript compatibility, and ensuring existing non-durable agent/session paths remain unchanged.

## PR 3 - Runtime store hardening and controls

### Summary

- Harden durable SQLite store behavior and DB adapter access.
- Strengthen coordination projection and durable gateway method tests.
- Tighten ordering/idempotency semantics for runtime state reads and writes.

### Scope

Durable persistence/control-plane hardening only.

### Test plan

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable/coordination-projection.test.ts src/durable/sqlite-store.test.ts src/gateway/server-methods/durable.test.ts
pnpm tsgo:core
```

### Reviewer notes

Please focus on recovery safety, state consistency, and method-level query behavior.

## PR 4 - Schema guardrails and generated DB alignment

### Summary

- Align durable runtime SQL schema, generated schema/type artifacts, and Kysely guardrails.
- Keep runtime naming consistent (`runtime_run_id`, `runtimeRunId`, `operation_kind`, `operationKind`).

### Scope

Schema and guardrails only.

### Test plan

```bash
pnpm lint:kysely
pnpm db:kysely:check
pnpm tsgo:core
git diff --check
```

### Reviewer notes

Please focus on generated artifact consistency and guardrail coverage.

## PR 5 - Private proof and review docs

### Summary

- Add durable-core-only private review plan.
- Update proof/test-plan language to exclude Workboard/TaskFlow plugin shards.
- Provide five private PR body templates.

### Scope

Docs only. No runtime behavior changes.

### Test plan

```bash
git diff --check
```

### Reviewer notes

This PR is intended to make the private stack reviewable before any public branch update.
