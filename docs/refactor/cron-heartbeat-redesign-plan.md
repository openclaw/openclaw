# Cron and Heartbeat Redesign Plan

## Purpose

This document turns the cron and heartbeat architecture investigation into an
implementation plan for OpenClaw. The goal is to fix the current ownership blur
between cron scheduling, heartbeat execution, detached runs, and outbound
delivery without doing a flag-day rewrite.

The intended workflow is:

1. capture the target architecture here
2. create pebbles issues that reference this document
3. implement the work as small, dependency-ordered tasks

## Executive Summary

The main architectural problem is not missing scheduling features. It is split
ownership of a single automation outcome across multiple subsystems.

Today:

- cron owns durable scheduling, due-time math, and partial run bookkeeping
- `sessionTarget="main"` cron jobs do not execute directly
- those jobs enqueue an in-memory system event
- heartbeat later decides whether and how to turn that event into a model run
- final user-visible delivery often happens inside heartbeat, not inside cron

That means there is no single subsystem that owns the complete lifecycle of a
main-session cron run from "job is due" through "reply delivered or failed".

The redesign should preserve current product behavior where practical, but move
the internal architecture to this model:

- cron owns the durable run lifecycle and final outcome for all cron jobs
- execution happens through explicit execution adapters
- heartbeat remains a scheduler-triggered main-session turn mechanism, but is no
  longer the hidden semantic owner of cron work
- outbound target resolution and delivery semantics converge onto shared logic
- restart semantics become durable and explainable

## Current State

### Main-session cron

Main-session cron currently routes through `executeMainSessionCronJob()` in
`src/cron/service/timer.ts`.

The relevant flow is:

1. resolve a text payload with `resolveJobPayloadTextForMain()`
2. enqueue a system event with context key `cron:<jobId>`
3. if `wakeMode === "now"`, try `runHeartbeatOnce()`
4. otherwise request a heartbeat wake
5. heartbeat later drains the pending system event queue
6. heartbeat builds a cron-specific prompt and runs the agent turn
7. heartbeat decides whether to relay the result to the user

This path is structurally important because cron and heartbeat split execution
responsibility:

- cron knows when the job was due
- heartbeat knows whether a model turn actually ran
- heartbeat often owns the actual delivery path

### In-memory handoff

`src/infra/system-events.ts` defines system events as a lightweight in-memory
queue. The file comment is explicit that the queue is intentionally not
persisted.

This is fine for ephemeral notifications, but it is a mismatch for durable cron
work. A durable scheduled job currently hands off to a non-durable queue before
the user-visible work actually happens.

### Heartbeat responsibilities

`src/infra/heartbeat-runner.ts` currently owns all of the following:

- preflight gating
- active-hours checks
- queue busy checks
- session selection
- isolated heartbeat session creation
- pending event inspection
- cron event prompt construction
- exec completion prompt construction
- `HEARTBEAT.md` parsing
- task-due evaluation for heartbeat task blocks
- model execution
- reasoning payload filtering
- delivery target selection
- outbound delivery
- transcript and session cleanup details

That is too much responsibility in one module. It also makes it easy for cron
behavior to accrete inside heartbeat because heartbeat already sits at the
center of multiple side-effecting concerns.

### Detached / isolated cron

Detached cron runs are comparatively cleaner. `runCronIsolatedAgentTurn()` and
the isolated-agent modules already own more of their execution lifecycle.

However, detached cron still duplicates delivery logic and target resolution in
places that overlap with heartbeat:

- `src/cron/isolated-agent/delivery-target.ts`
- `src/cron/isolated-agent/delivery-dispatch.ts`
- `src/infra/outbound/targets.ts`
- `src/infra/outbound/deliver.ts`

This duplication increases the chance that thread handling, account selection,
or "last target" behavior drifts between heartbeat and cron.

## Concrete Architectural Problems

### 1. Durable schedule, non-durable execution handoff

The most serious mismatch is:

- due-time state is persisted in the cron store
- main-session execution requests are not

If the process crashes after enqueueing a system event but before heartbeat
drains it, cron has already moved forward while the execution request is lost.

### 2. Final outcome ownership is ambiguous

Cron emits run events and updates job state. Heartbeat decides whether a main
session turn actually happened and what was delivered. This leads to partial
truth in each subsystem rather than one authoritative run record.

### 3. Wake mode changes execution subsystem, not just timing

`wakeMode` appears to be a scheduling knob, but it materially changes execution
behavior:

- `now` attempts to force immediate heartbeat execution
- `next-heartbeat` relies on later heartbeat scheduling

That means a timing field also selects the execution path, which makes the
behavior harder to reason about from configuration alone.

### 4. Delivery resolution is split

Heartbeat and isolated cron both need to answer:

- which channel should receive output
- which recipient should be used
- which account id should be applied
- whether a thread/topic id should be preserved
- when direct delivery should be blocked or allowed

Those decisions should be owned by shared outbound resolution logic, not by
two partially overlapping stacks.

### 5. Heartbeat is both a feature and an execution substrate

Heartbeat should be conceptually simple: periodically run a main-session turn
based on `HEARTBEAT.md` or similar workspace instructions.

Instead, heartbeat is also being used as:

- a cron reminder executor
- an exec completion relay mechanism
- an isolated-session recycling coordinator
- a delivery policy owner

That is an architectural smell. Cron and exec completion can reuse heartbeat
execution machinery, but only through explicit seams.

## Goals

### Primary goals

- give every cron run one clear owner for final outcome
- make main-session cron execution durable or explicitly non-durable with a new
  product concept
- reduce delivery logic duplication
- make restart semantics explicit and testable
- split heartbeat into smaller, scheduler-neutral modules

### Secondary goals

- preserve existing user-facing configuration where feasible
- avoid a rewrite that invalidates unrelated cron and heartbeat behavior
- keep extension/channel boundaries intact
- maintain prompt-cache stability where request assembly changes

### Non-goals

- redesign the public cron job schema from scratch
- change heartbeat product semantics unrelated to architecture
- merge heartbeat and cron into a single user-facing feature
- remove isolated cron or heartbeat isolated sessions

## Target Architecture

## Ownership Model

The target model should be:

- `CronService` owns job schedules and durable run records
- `CronExecutionOrchestrator` owns execution dispatch for a specific run
- execution adapters perform the actual work
- outbound delivery is resolved and executed through shared infra
- heartbeat is a reusable execution adapter, not the semantic owner of cron

In other words:

due job -> durable cron run -> explicit execution adapter -> shared delivery ->
final persisted outcome

## Execution adapters

Introduce explicit execution modes for cron runs:

- `main-session-turn`
- `detached-session-turn`
- `webhook`

Possible future adapters can be added later without changing the scheduler
ownership model.

### `main-session-turn`

This adapter represents "perform this cron-triggered turn in the main session".

Important point: this is not the same as "enqueue a system event and hope
heartbeat gets to it". The adapter may internally use heartbeat machinery for
prompt building or turn execution, but the adapter must receive a durable
execution request tied to a cron run id.

### `detached-session-turn`

This covers today's isolated/current/session-bound cron execution modes and
should own:

- session lifecycle
- prompt execution
- result synthesis
- shared outbound delivery integration

### `webhook`

Webhook delivery can stay simpler because it is already closer to a direct,
single-owner execution path.

## Durable run record

Cron needs a durable run object separate from job state. The job state can keep
last-run summaries for listing and status, but the run record should be the
authoritative lifecycle entry.

Proposed minimum fields:

- `runId`
- `jobId`
- `scheduledAtMs`
- `startedAtMs`
- `completedAtMs`
- `executionMode`
- `status`
- `deliveryStatus`
- `sessionKey`
- `sessionId`
- `summary`
- `error`
- `provider`
- `model`
- `usage`
- `handoffState`

Suggested status vocabulary:

- `pending`
- `running`
- `succeeded`
- `failed`
- `skipped`

Suggested delivery status vocabulary:

- `not_requested`
- `pending`
- `delivered`
- `failed`
- `unknown`

If desired, the existing event vocabulary can continue to map onto these more
precise run states for UI compatibility.

## Durable scheduled-turn request

Main-session cron needs a durable request object representing the pending turn.

This request should include:

- `requestId`
- `source = cron`
- `runId`
- `jobId`
- `agentId`
- `sessionKey`
- `prompt/input text`
- `delivery intent`
- `createdAtMs`
- `claimedAtMs`
- `completedAtMs`

Heartbeat may initially consume this request because it already has main-session
turn execution machinery. But the request must be durable and claimable, not a
raw entry in the ephemeral system-event queue.

## Shared outbound resolution

The target architecture should have one shared outbound resolution layer that
all automation paths use.

That shared layer should answer:

- which target channel is used
- how `last` is resolved
- how explicit `to` overrides are handled
- how account id precedence works
- when thread/topic ids are retained or dropped
- when direct delivery is blocked
- how plugin-provided target normalization participates

`deliverOutboundPayloads()` can remain the common sink. The main missing piece
is consolidating target resolution and policy logic.

## Heartbeat module split

`src/infra/heartbeat-runner.ts` should be broken into smaller modules with clear
ownership:

- `heartbeat-preflight`
- `heartbeat-prompt`
- `heartbeat-executor`
- `heartbeat-delivery`
- `heartbeat-session`

The exact file names can vary, but the responsibilities should separate along
those seams.

This will let cron reuse a main-session turn executor without inheriting
heartbeat-only product semantics by accident.

## Proposed Module Plan

### New cron-side modules

- `src/cron/service/run-records.ts`
  durable run creation, updates, lookups, and retention

- `src/cron/execution/orchestrator.ts`
  select execution adapter, drive status transitions, and own final outcome

- `src/cron/execution/adapters/main-session-turn.ts`
  durable handoff into main-session execution

- `src/cron/execution/adapters/detached-session-turn.ts`
  extracted detached execution wrapper around existing isolated cron machinery

- `src/cron/execution/adapters/webhook.ts`
  explicit webhook execution path if needed

- `src/cron/execution/types.ts`
  closed unions for execution state and adapter result contracts

- `src/cron/execution/shared-delivery.ts`
  cron-facing integration with the shared outbound resolver

### New shared execution request module

- `src/infra/scheduled-turn-requests.ts`
  durable pending-turn request store with create/claim/complete behavior

This should be general enough for cron first, without prematurely widening the
surface to unrelated features.

### Heartbeat decomposition targets

- `src/infra/heartbeat-preflight.ts`
- `src/infra/heartbeat-prompt.ts`
- `src/infra/heartbeat-executor.ts`
- `src/infra/heartbeat-delivery.ts`
- `src/infra/heartbeat-session.ts`

The top-level `heartbeat-runner.ts` can stay as the orchestration shell while
the implementation details move into those modules.

## Migration Strategy

This should be a staged redesign through incremental cleanup.

### Phase 1: Durable run ownership

Introduce durable cron run records without changing user-facing behavior.

Scope:

- create run record on due/forced execution
- preserve existing job state updates
- tie `runId` to both main-session and detached execution paths
- do not yet replace main-session system-event handoff

Success criteria:

- every cron execution has a durable run record
- final status can be tied back to a run id
- cron no longer treats "attempted handoff" as equivalent to "succeeded"

### Phase 2: Main-session durable execution request

Replace direct main-session system-event enqueue as the execution handoff for
cron with a durable scheduled-turn request.

Scope:

- create durable request records for main-session cron runs
- teach heartbeat or a cron-owned consumer to claim and execute them
- keep existing prompt shape for compatibility where possible

Success criteria:

- restart no longer loses pending main-session cron work
- cron can observe whether a main-session turn actually completed
- handoff state is explicit in the durable run record

### Phase 3: Heartbeat decomposition

Split heartbeat into focused modules without changing behavior.

Scope:

- extract preflight, prompt, session, execution, delivery logic
- keep current `runHeartbeatOnce()` entrypoint

Success criteria:

- smaller modules with clearer ownership
- cron can reuse executor pieces through explicit interfaces

### Phase 4: Shared outbound resolution

Collapse duplicated delivery target logic.

Scope:

- compare heartbeat and isolated-cron target behavior
- move common target logic under shared outbound infra
- preserve special channel/plugin behaviors through shared seams

Success criteria:

- one place to fix routing/account/thread bugs
- heartbeat and cron agree on target semantics

### Phase 5: Cleanup and behavior simplification

Once durable execution and shared delivery exist, simplify remaining legacy
paths and remove compatibility shims that are no longer needed.

Possible cleanup targets:

- main-session cron-specific implicit heartbeat coupling
- duplicate delivery-plan helpers that only exist for the old split path
- run-state fields that duplicate durable run records without adding value

## Task Breakdown

The implementation should be broken into the following pebbles tasks.

### Task A: Persist cron run lifecycle

Deliverables:

- durable run store
- run record types
- creation/update helpers
- integration into cron due/force execution
- tests for create/update/restart visibility

Dependencies:

- none

### Task B: Extract cron execution orchestrator

Deliverables:

- move execution branching out of `src/cron/service/timer.ts`
- explicit adapter contracts
- scheduler reduced to due-time and run dispatch responsibilities

Dependencies:

- Task A

### Task C: Add durable main-session scheduled-turn requests

Deliverables:

- request store
- create/claim/complete helpers
- cron main-session path uses durable requests instead of only in-memory events
- restart coverage

Dependencies:

- Task A
- Task B

### Task D: Decompose heartbeat runner

Deliverables:

- extracted modules for preflight/prompt/execution/delivery/session
- behavior-preserving tests

Dependencies:

- Task C can proceed in parallel for some subparts, but the safer ordering is
  after Task B so the seam is clearer

### Task E: Unify outbound target resolution

Deliverables:

- shared target resolution path for heartbeat and detached cron
- parity coverage for account/thread/last-target behavior

Dependencies:

- Task B
- ideally after Task D so heartbeat delivery seams are explicit

### Task F: Final cleanup and docs

Deliverables:

- remove obsolete bridging code
- document the new internal ownership model
- ensure run logs and operational docs match reality

Dependencies:

- Tasks C, D, and E

## Testing Plan

### Unit and integration coverage

Add or update tests for:

- due cron run creates durable run record
- force run creates durable run record
- detached cron success/failure updates run record correctly
- main-session cron crash/restart preserves pending work
- claimed scheduled-turn request is not executed twice
- busy-lane retries do not lose run ownership
- delivery success/failure updates both run record and job summary correctly
- thread/account/last-target behavior matches between heartbeat and cron

### Regression focus

Protect these existing behavior classes:

- one-shot disable/retry behavior
- recurring backoff behavior
- startup catch-up behavior
- `wakeMode="now"` busy retry fallback
- `HEARTBEAT_OK` ack stripping for heartbeat product behavior
- isolated heartbeat session key stability
- direct delivery idempotency for detached cron

### Restart and durability scenarios

Explicitly test:

- crash after cron marks a run started but before execution begins
- crash after main-session request is created but before it is claimed
- crash after request is claimed but before completion is recorded
- restart with stale pending requests

## Risks and Constraints

### Prompt-cache stability

The repo guidance is explicit that prompt-cache stability is correctness and
performance sensitive.

Any new request assembly for pending cron/main-session execution must preserve
deterministic ordering. If durable scheduled-turn requests feed prompt context,
the order in which they are assembled must be stable across runs.

### Public behavior drift

This plan changes internals first. It should not casually change:

- visible cron configuration
- heartbeat prompt semantics
- plugin/channel contracts
- transcript ownership rules

### Channel and plugin boundaries

Do not solve delivery drift by hardcoding channel-specific logic into cron or
heartbeat. Shared outbound resolution must continue to rely on existing plugin
and channel seams.

### Operational complexity

Adding durable run and request stores introduces new retention and cleanup work.
Retention policy should be explicit from the beginning to avoid unbounded growth.

## Recommended First Slice

The first implementation slice should be:

1. persist cron run lifecycle
2. extract the execution orchestrator seam just enough to support the run record
3. begin the durable main-session request path

Reason:

- this fixes the biggest architectural lie first
- it creates an explicit place for later heartbeat decomposition
- it avoids a risky heartbeat rewrite before ownership is clarified

## Open Questions

These should be resolved during implementation, but they do not block the plan:

- whether durable scheduled-turn requests should live in the cron store or a new
  infra-level store
- whether the durable request mechanism should be cron-specific first or
  generalized immediately
- how much existing system-event prompt wording should be preserved verbatim for
  main-session cron compatibility
- whether run retention belongs in cron config or should start with a fixed
  default

## Definition of Done

This redesign is done when:

- every cron run has one durable owner for final outcome
- main-session cron no longer relies solely on an ephemeral queue to bridge
  durable scheduling to actual execution
- heartbeat is no longer the hidden owner of cron work
- heartbeat delivery and detached cron delivery share one target-resolution
  contract
- restart scenarios are covered by tests and behave predictably
