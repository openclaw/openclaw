# Durable Workflow Core Upstream PR Stack

Status: preparation document for splitting the OpenClaw-X durable core work into
small upstream-friendly pull requests.

Date: 2026-06-28

## Executive Assessment

The current branch contains a real native durable coordination slice, but it is
not yet a complete durable workflow engine.

It is native because the control plane is implemented inside OpenClaw rather
than delegated entirely to Temporal, Restate, Hatchet, LangGraph, or an
AICOS-specific bridge. It records workflow runs, events, steps, refs, timers,
signals, parent/child links, agent turns, subagent child runs, recovery state,
and coordination projections in OpenClaw's runtime state.

It is durable because accepted agent work can survive gateway process restarts
as inspectable state. Lost, failed, cancelled, waiting, retry, and child terminal
states are explicit records instead of only transient process memory.

It is still a slice because it does not yet provide a long-running worker loop,
storage abstraction beyond SQLite, schema migration policy, deterministic
replay, or a full workflow SDK. The branch now includes an initial in-process
registry and one-shot executor kernel, but those pieces are not wired as a
production worker yet.

The right upstream message is:

> Add a local-first durable coordination core for agent runs and subagent
> fan-in, starting with inspectable runtime state and recovery primitives.

Avoid claiming:

> Add a Temporal-compatible workflow engine.

## What Exists Now

Current implemented capabilities:

- SQLite-backed local-first durable store.
- Workflow run, event, step, ref, link, timer, and signal primitives.
- Durable startup lifecycle records.
- Durable gateway agent turn records.
- Durable input refs for agent turns without storing raw prompts by default.
- Gateway startup reconciliation for previously in-flight agent turns.
- Recovery worker that marks stale agent turns lost and processes durable
  recovery transitions.
- Subagent child workflow records and parent/child links.
- Fan-in policy helper that can continue parents when children fail, depending
  on policy.
- Best-effort TaskFlow projection writer.
- Durable coordination projection API.
- Gateway method `durable.coordination.get`.
- Workboard-side projection adapter and typed `metadata.durable` persistence.
- Workboard gateway method `workboard.cards.applyDurableProjection`.
- Step-level claim/release.
- In-process workflow registry.
- One-shot durable executor for safe registered step handlers.

The design remains upstream-friendly because core durable code does not import
Workboard plugin code, does not hard-code AICOS names, and keeps projection
writes best-effort.

## What Is Still Missing

Required before calling this a full core module:

- Long-running worker loop that claims runnable steps and resumes safe work.
- Durable dispatch path from Workboard and other frontdoors.
- Storage interface with SQLite default and Postgres-compatible implementation.
- Schema migration/versioning policy for the durable store.
- Durable task audit integration before task cleanup marks work lost.
- Workboard UI rendering for durable state, not only metadata persistence.
- Explicit side-effect uncertainty handling for model, tool, and message-send
  operations that may have completed before a crash.
- Durable workflow versioning policy.
- Operator-facing timeline and diagnostics polished enough for support.
- Multi-worker leasing and claim-expiry behavior tested under contention.

## Scalability Direction

The durable core should scale by contract, not by making the first PR large.

Keep the first implementation local-first:

- SQLite is the default runtime store.
- Postgres support comes through the same storage interface later.
- Runtime semantics are at-least-once with idempotent steps.
- Exactly-once should not be promised across external side effects.
- Event history is used for audit and recovery decisions.
- Checkpoint/resume state machines are preferred over Temporal-style
  deterministic replay for the initial agent kernel.

This model fits OpenClaw because agent work often includes non-deterministic LLM
calls, tools, workspace mutations, and human input. The durable core should make
state, ownership, waits, retries, and fan-in explicit; it should not require all
agent code to be deterministic workflow code.

## PR Stack

Do not upstream this branch as one pull request. Split it into reviewable layers.

### PR 1: Durable Store Primitives

Goal:

- Introduce durable workflow control-plane types and SQLite store primitives.

Scope:

- `src/durable/types.ts`
- `src/durable/sqlite-store.ts`
- `src/durable/config.ts`
- low-level store tests

Public surface:

- runs;
- events;
- steps;
- refs;
- parent/child links;
- timers;
- signals;
- run claims.

Acceptance criteria:

- Store creates schema in OpenClaw state dir.
- Idempotency key uniqueness is enforced per workflow.
- Event sequence is monotonic per run.
- Tests cover create/update/list/read paths.

Review risk:

- Medium. This adds schema and runtime persistence, but no behavior changes if
  not wired into gateway execution.

Rollback:

- Remove durable module and command registration from later PRs.

### PR 2: Durable CLI and Operator Inspection

Goal:

- Let maintainers inspect durable state without reading SQLite manually.

Scope:

- `src/commands/durable.ts`
- `src/cli/program/register.durable.ts`
- CLI command descriptors
- docs for `openclaw durable`

Commands:

- list runs;
- show run;
- timeline;
- steps;
- refs;
- timers;
- signals;
- coordination projection if PR 5 has landed.

Acceptance criteria:

- CLI is read-only by default.
- JSON output is available for tooling.
- No gateway behavior changes.

Review risk:

- Low. Mostly operator tooling.

### PR 3: Gateway Agent Turn Lifecycle

Goal:

- Record every accepted gateway agent turn as a durable workflow run.

Scope:

- `src/gateway/server-methods/agent.ts`
- gateway run-loop startup hook
- durable startup helper
- agent turn tests

Behavior:

- create durable input ref;
- create agent invocation step;
- record received/running/succeeded/failed/cancelled/lost events;
- avoid raw prompt persistence by default;
- support opt-out or feature flag while maturing.

Acceptance criteria:

- Normal chat still works when durable core is disabled.
- Accepted messages have durable run ids when enabled.
- Gateway restart can show previously running work as lost or recoverable.

Review risk:

- High compared with earlier PRs because it touches request handling.

Mitigation:

- Keep the durable write path best-effort or feature-gated initially.
- Never block normal message handling because durable inspection metadata failed.

### PR 4: Recovery Worker, Timers, Signals, and Cancellation

Goal:

- Make silence diagnosable and make waits explicit.

Scope:

- `src/durable/recovery.ts`
- startup recovery registration
- timer/signal/cancellation tests

Behavior:

- mark stale in-flight runs as lost;
- process retry timers;
- process pending cancellation/resume signals;
- update heartbeat and recovery state;
- report `unknown_after_side_effect` instead of blindly replaying unsafe work.

Acceptance criteria:

- Gateway restart does not erase accepted work state.
- Stale work is visible as stale/lost, not silent.
- Retry/cancel/signal state can be inspected through CLI.

Review risk:

- Medium. This improves visibility first; automatic re-execution should remain
  conservative until the executor PR.

### PR 5: Subagent Links and Fan-In Policy

Goal:

- Prevent parent agents from silently blocking when subagents complete, fail,
  overflow, or are cancelled.

Scope:

- `src/durable/fan-in.ts`
- `src/durable/subagent.ts`
- `src/agents/subagent-registry-run-manager.ts`
- fan-in and subagent tests

Behavior:

- create child workflow run for subagent work;
- link child run to parent run/step;
- update child link terminal state;
- reconcile parent fan-in step;
- allow policy-driven continuation with partial results.

Acceptance criteria:

- Child success unblocks parent fan-in.
- Child failure does not block parent when policy allows continuation.
- Lost/cancelled/overflow outcomes become durable terminal child states.
- Parent and child runs are never mixed across branches.

Review risk:

- High. This is the first PR directly addressing multi-agent coordination.

Mitigation:

- Keep the policy small and explicit.
- Avoid changing prompt/persona/profile behavior.

### PR 6: Durable Coordination Projection and Gateway Read API

Goal:

- Provide a stable read model for UI, plugins, frontdoors, and operators.

Scope:

- `src/durable/coordination-projection.ts`
- `src/gateway/server-methods/durable.ts`
- gateway method descriptors and tests
- `docs/gateway/protocol.md`

API:

- `durable.coordination.get`

Acceptance criteria:

- Requires `operator.read`.
- Returns current run status, waiting reason, child counts, terminal reason, and
  timeline command.
- Does not expose raw prompts or full event payloads by default.

Review risk:

- Medium. New gateway API, but read-only.

### PR 7: Background Task and TaskFlow Binding

Goal:

- Connect durable coordination state to existing OpenClaw task surfaces without
  making those surfaces the source of truth.

Scope:

- subagent task metadata binding;
- `src/durable/taskflow-bridge.ts`;
- TaskFlow projection tests.

Behavior:

- pass `taskId` and `taskFlowId` into durable run metadata when available;
- provide a best-effort helper that can sync compact durable projection into
  TaskFlow state/wait JSON when an adapter calls it;
- keep projection writes best-effort.

Acceptance criteria:

- Durable run remains the source of truth.
- TaskFlow can show durable wait/lost/retry state.
- Projection failure never blocks agent execution.

Review risk:

- Medium. This touches existing task surfaces.

Mitigation:

- Keep all bindings optional.
- Preserve existing TaskFlow fields.

### PR 8: Workboard Projection Adapter

Goal:

- Let Workboard consume durable coordination state without making Workboard a
  core dependency.

Scope:

- `extensions/workboard/src/durable-adapter.ts`
- `extensions/workboard/src/types.ts`
- `extensions/workboard/src/store.ts`
- `extensions/workboard/src/gateway.ts`
- Workboard tests

API:

- `workboard.cards.applyDurableProjection`

Behavior:

- store compact `metadata.durable`;
- map durable status into Workboard card status;
- preserve previous durable metadata when partial card updates occur.

Acceptance criteria:

- Workboard can accept a durable projection.
- Core durable module imports no Workboard code.
- Card status mapping is deterministic and tested.

Review risk:

- Medium. Plugin-only, but reviewers may ask to split type/store/gateway pieces.

### PR 9: Documentation and Architecture Notes

Goal:

- Explain the durable core boundaries before expanding runtime behavior.

Scope:

- durable core definition;
- architecture sketch;
- gateway protocol docs;
- recovery semantics;
- anti-goals;
- future storage and executor plans.

Acceptance criteria:

- Docs explain what is and is not durable.
- Docs avoid AICOS-specific terms.
- Docs make clear that this is a native coordination core, not a Temporal clone.

Review risk:

- Low. Should accompany earlier PRs, but can be a separate docs PR if needed.

### PR 10: Executor Kernel Prototype

Goal:

- Add the minimal runtime kernel needed to move from durable inspection to
  durable execution.

Scope:

- step-level claim/release in `DurableWorkflowStore`;
- SQLite implementation of step claims;
- in-process workflow registry;
- one-shot durable executor;
- executor tests.

Behavior:

- claim one runnable step;
- mark run/step running;
- call a registered step handler;
- persist heartbeat, output, error, retry timer, wait state, or
  unknown-after-side-effect;
- release claim on terminal/waiting/retry outcomes.

Acceptance criteria:

- Success writes output ref and can complete the run.
- Retryable failure writes error ref and retry timer.
- Missing handlers become `unknown_after_side_effect`, not blind replay.
- Existing agent/subagent paths are not automatically executed by the generic
  executor until a later feature-flagged worker-loop PR.

Review risk:

- Medium. This is core runtime behavior, but it is isolated and not wired into
  gateway startup.

## Later PRs Not Ready Yet

These should not be bundled into the first upstream stack:

1. Long-running worker loop for the executor kernel.
2. Workflow SDK and declarative workflow definitions.
3. Pluggable storage interface and Postgres implementation.
4. Durable Workboard dispatch path.
5. Workboard UI timeline/status rendering.
6. Task audit durable recovery integration.
7. Multi-worker claim/lease contention tests.
8. Durable workflow versioning and migration policy.
9. External adapters for Restate, Temporal, Hatchet, or LangGraph.

## Upstream-Friendly Rules

- Keep the durable core optional while it matures.
- Do not hard-code AICOS, Discord, Slack, dashboard, or enterprise terms.
- Keep profile, memory, skill, and prompt semantics outside durable workflow
  state.
- Never make Workboard a required dependency of core durable code.
- Prefer compact projections over duplicating the event journal into every
  surface.
- Do not promise exactly-once external side effects.
- Make side-effect uncertainty visible instead of hiding it.
- Keep SQLite first; add Postgres through an interface later.
- Add tests with every behavioral PR.

## Native Core Readiness Checklist

Before calling this "OpenClaw Durable Core" instead of "durable coordination
slice", the branch should satisfy:

- every accepted frontdoor message gets a durable identity;
- every long-running step updates heartbeat/progress;
- every parent wait has an explicit durable reason;
- every spawned subagent has a durable child run or explicit non-durable reason;
- child terminal states reconcile parent fan-in;
- failed child branches do not block the parent unless policy says they should;
- gateway restart leaves accepted work inspectable and recoverable;
- operator CLI and gateway API can explain why work is quiet;
- retry/cancel/human-signal transitions are durable and idempotent;
- unsafe replay after side effects is marked explicitly;
- storage schema can evolve safely;
- future Postgres/multi-worker support does not require changing public durable
  identifiers.

## Recommended Next Engineering Step

The next code milestone after the current executor kernel should be a
feature-flagged worker loop that can:

1. poll for runnable durable steps;
2. enforce max concurrency;
3. run registered safe handlers;
4. stop cleanly on gateway shutdown;
5. leave unsafe side-effect steps in inspectable waiting state;
6. expose worker health through CLI/gateway diagnostics.

That milestone is the line between one-shot durable execution and an always-on
native durable workflow runtime.
