# Durable Core Private Review Plan - 2026-07-07

## Goal

Prepare the existing private durable-runtime work for a five-PR private review stack without publishing or pushing public branches.

The stack should stay focused on durable core runtime behavior: runtime identity, persistence, recovery, gateway intake, agent/session wiring, and schema guardrails.

## Root cause

The current branch mixes two review narratives:

1. durable core runtime primitives and runtime persistence; and
2. coordination surfaces that can be consumed by Workboard/TaskFlow-style clients.

The implementation itself is mostly durable-core, but the proof document referenced Workboard shards and Workboard-specific contract checks. That makes the review look broader than the durable core stack and risks pulling plugin/workboard reviewers into a runtime persistence change.

## Durable-core files in scope

Primary durable core:

- `src/durable/**`
- `src/gateway/server-methods/durable.ts`
- `src/gateway/server-methods/durable.test.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/methods/core-descriptors.ts`
- `src/cli/program/register.durable.ts`
- `src/commands/durable.ts`
- `src/cli/gateway-cli/run-loop.ts`
- `src/cli/program/command-registry-core.ts`
- `src/cli/program/core-command-descriptors.ts`
- `src/state/openclaw-state-schema.sql`
- `src/state/openclaw-state-schema.generated.ts`
- `src/state/openclaw-state-db.generated.d.ts`
- `src/state/openclaw-state-db.ts`
- `scripts/check-kysely-guardrails.mjs`
- `docs/gateway/protocol.md`
- `docs/specs/durable-runtime-pr-proof-2026-07-01.md`

Agent/session runtime integration in scope for later PRs:

- `src/agents/embedded-agent-runner/**`
- `src/agents/openclaw-tools.ts`
- `src/agents/subagent-announce.ts`
- `src/agents/subagent-registry-lifecycle.*`
- `src/agents/subagent-registry-run-manager.ts`
- `src/agents/subagent-spawn.ts`
- `src/agents/system-prompt.*`
- `src/agents/tools/gateway-tool.*`
- `src/agents/tools/sessions-spawn-tool.ts`
- `src/gateway/chat-display-projection.ts`
- `src/gateway/context-refs.*`
- `src/gateway/server-methods/agent.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/server-methods.test.ts`
- `src/sessions/user-turn-transcript.*`
- `src/tasks/task-completion-contract.*`
- `src/tasks/task-executor-policy.*`
- `packages/gateway-protocol/src/**`

## Out of scope for this private durable-core stack

Do not include Workboard/plugin proof or TaskFlow-specific review claims in PR bodies:

- `extensions/workboard/**`
- Workboard archive tool contract checks
- Workboard embedded chat UI/panel changes
- TaskFlow product-level behavior claims beyond durable runtime fields that enable future consumers

Note: `src/durable/taskflow-bridge.*` exists in the current durable runtime foundation commit. For a strict durable-core-only review, either rename/reframe this as a generic coordination bridge in a future split, or keep it in the foundation PR with explicit wording that it is an internal adapter and not a TaskFlow product feature.

## Proposed five-PR private stack

1. **Durable runtime foundation**
   - Adds durable runtime modules, runtime IDs, intake/envelope handling, executor, recovery, worker, startup, store factory, SQLite store, and CLI/gateway registration.
   - Reviewer focus: data model, feature flag, lifecycle boundaries, persistence APIs.

2. **Agent/session runtime wiring**
   - Wires agent turns, subagent announce/spawn/lifecycle, context refs, transcripts, gateway chat/agent methods, and protocol schema so runtime work can carry first-class context.
   - Reviewer focus: no behavior regression for non-durable runs, context propagation, protocol compatibility.

3. **Runtime store hardening and controls**
   - Strengthens SQLite store behavior, coordination projection behavior, durable gateway method tests, and DB adapter surface.
   - Reviewer focus: idempotency, ordering, recovery safety, method-level access patterns.

4. **Schema guardrails and generated DB alignment**
   - Aligns generated schema/types and Kysely guardrails with durable runtime tables and naming.
   - Reviewer focus: generated artifacts match SQL, guardrails prevent drift.

5. **Private review proof and PR templates**
   - Documents durable-core-only scope, root cause, test plan, PR bodies, and known non-goals.
   - Reviewer focus: reviewability and evidence completeness.

## Test plan for private review

Durable-core-only recommended checks:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable src/gateway/server-methods/durable.test.ts src/gateway/context-refs.test.ts
pnpm tsgo:core
pnpm tsgo:core:test
pnpm lint:kysely
git diff --check
```

Optional broader checks before public push, if desired:

```bash
pnpm build
pnpm test:gateway
```

Workboard/TaskFlow/plugin shards are intentionally excluded from the durable-core proof unless a later reviewer asks for cross-consumer regression evidence.
