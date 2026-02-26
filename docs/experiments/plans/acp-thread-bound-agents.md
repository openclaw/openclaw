---
summary: "Integrate ACP coding agents via a first-class ACP control plane in core and plugin-backed runtimes (acpx first)"
owner: "onutc"
status: "draft"
last_updated: "2026-02-25"
title: "ACP Thread Bound Agents"
---

# ACP Thread Bound Agents

## Overview

This plan defines how OpenClaw should support ACP coding agents in thread-capable channels (Discord first) with production-level lifecycle and recovery.

Related document:

- [Unified Runtime Streaming Refactor Plan](/experiments/plans/acp-unified-streaming-refactor)

Target user experience:

- a user spawns or focuses an ACP session into a thread
- user messages in that thread route to the bound ACP session
- agent output streams back to the same thread persona
- session can be persistent or one shot with explicit cleanup controls

## Decision summary

Long term recommendation is a hybrid architecture:

- OpenClaw core owns ACP control plane concerns
  - session identity and metadata
  - thread binding and routing decisions
  - delivery invariants and duplicate suppression
  - lifecycle cleanup and recovery semantics
- ACP runtime backend is pluggable
  - first backend is an acpx-backed plugin service
  - runtime does ACP transport, queueing, cancel, reconnect

OpenClaw should not reimplement ACP transport internals in core.
OpenClaw should not rely on a pure plugin-only interception path for routing.

## North-star architecture (holy grail)

Treat ACP as a first-class control plane in OpenClaw, with pluggable runtime adapters.

Non-negotiable invariants:

- every ACP thread binding references a valid ACP session record
- every ACP session has explicit lifecycle state (`creating`, `idle`, `running`, `cancelling`, `closed`, `error`)
- every ACP run has explicit run state (`queued`, `running`, `completed`, `failed`, `cancelled`)
- spawn, bind, and initial enqueue are atomic
- command retries are idempotent (no duplicate runs or duplicate Discord outputs)
- bound-thread channel output is a projection of ACP run events, never ad-hoc side effects

Long-term ownership model:

- `AcpSessionManager` is the single ACP writer and orchestrator
- manager lives in gateway process first; can be moved to a dedicated sidecar later behind the same interface
- per ACP session key, manager owns one in-memory actor (serialized command execution)
- adapters (`acpx`, future backends) are transport/runtime implementations only

Long-term persistence model:

- move ACP control-plane state to a dedicated SQLite store (WAL mode) under OpenClaw state dir
- keep `SessionEntry.acp` as compatibility projection during migration, not source-of-truth
- store ACP events append-only to support replay, crash recovery, and deterministic delivery

### Delivery strategy (bridge to holy-grail)

- short-term bridge
  - keep current thread binding mechanics and existing ACP config surface
  - fix metadata-gap bugs and route ACP turns through a single core ACP branch
  - add idempotency keys and fail-closed routing checks immediately
- long-term cutover
  - move ACP source-of-truth to control-plane DB + actors
  - make bound-thread delivery purely event-projection based
  - remove legacy fallback behavior that depends on opportunistic session-entry metadata

## Why not pure plugin only

Current plugin hooks are not sufficient for end to end ACP session routing without core changes.

- inbound routing from thread binding resolves to a session key in core dispatch first
- message hooks are fire-and-forget and cannot short-circuit the main reply path
- plugin commands are good for control operations but not for replacing core per-turn dispatch flow

Result:

- ACP runtime can be pluginized
- ACP routing branch must exist in core

## Existing foundation to reuse

Already implemented and should remain canonical:

- thread binding target supports `subagent` and `acp`
- inbound thread routing override resolves by binding before normal dispatch
- outbound thread identity via webhook in reply delivery
- `/focus` and `/unfocus` flow with ACP target compatibility
- persistent binding store with restore on startup
- unbind lifecycle on archive, delete, unfocus, reset, and delete

This plan extends that foundation rather than replacing it.

## Architecture

### Boundary model

Core (must be in OpenClaw core):

- ACP session-mode dispatch branch in the reply pipeline
- delivery arbitration to avoid parent plus thread duplication
- ACP control-plane persistence (with `SessionEntry.acp` compatibility projection during migration)
- lifecycle unbind and runtime detach semantics tied to session reset/delete

Plugin backend (acpx implementation):

- ACP runtime worker supervision
- acpx process invocation and event parsing
- ACP command handlers (`/acp ...`) and operator UX
- backend-specific config defaults and diagnostics

### Runtime ownership model

- one gateway process owns ACP orchestration state
- ACP execution runs in supervised child processes via acpx backend
- process strategy is long lived per active ACP session key, not per message

This avoids startup cost on every prompt and keeps cancel and reconnect semantics reliable.

### Core runtime contract

Add a core ACP runtime contract so routing code does not depend on CLI details and can switch backends without changing dispatch logic:

```ts
export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
};

export type AcpRuntimeEvent =
  | { type: "text_delta"; stream: "output" | "thought"; text: string }
  | { type: "tool_call"; name: string; argumentsText: string }
  | { type: "done"; usage?: Record<string, number> }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export interface AcpRuntime {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    env?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<AcpRuntimeHandle>;

  submit(input: {
    handle: AcpRuntimeHandle;
    text: string;
    mode: AcpRuntimePromptMode;
    idempotencyKey: string;
  }): Promise<{ runtimeRunId: string }>;

  stream(input: {
    handle: AcpRuntimeHandle;
    runtimeRunId: string;
    onEvent: (event: AcpRuntimeEvent) => Promise<void> | void;
    signal?: AbortSignal;
  }): Promise<void>;

  cancel(input: {
    handle: AcpRuntimeHandle;
    runtimeRunId?: string;
    reason?: string;
    idempotencyKey: string;
  }): Promise<void>;

  close(input: { handle: AcpRuntimeHandle; reason: string; idempotencyKey: string }): Promise<void>;

  health?(): Promise<{ ok: boolean; details?: string }>;
}
```

Implementation detail:

- first backend: `AcpxRuntime` shipped as a plugin service
- core resolves runtime via registry and fails with explicit operator error when no ACP runtime backend is available

### Control-plane data model and persistence

Long-term source-of-truth is a dedicated ACP SQLite database (WAL mode), for transactional updates and crash-safe recovery:

- `acp_sessions`
  - `session_key` (pk), `backend`, `agent`, `mode`, `cwd`, `state`, `created_at`, `updated_at`, `last_error`
- `acp_runs`
  - `run_id` (pk), `session_key` (fk), `state`, `requester_message_id`, `idempotency_key`, `started_at`, `ended_at`, `error_code`, `error_message`
- `acp_bindings`
  - `binding_key` (pk), `thread_id`, `channel_id`, `account_id`, `session_key` (fk), `expires_at`, `bound_at`
- `acp_events`
  - `event_id` (pk), `run_id` (fk), `seq`, `kind`, `payload_json`, `created_at`
- `acp_delivery_checkpoint`
  - `run_id` (pk/fk), `last_event_seq`, `last_discord_message_id`, `updated_at`
- `acp_idempotency`
  - `scope`, `idempotency_key`, `result_json`, `created_at`, unique `(scope, idempotency_key)`

```ts
export type AcpSessionMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};
```

Storage rules:

- keep `SessionEntry.acp` as a compatibility projection during migration
- process ids and sockets stay in memory only
- durable lifecycle and run status live in ACP DB, not generic session JSON
- if runtime owner dies, gateway rehydrates from ACP DB and resumes from checkpoints

### Routing and delivery

Inbound:

- keep current thread binding lookup as first routing step
- if bound target is ACP session, route to ACP runtime branch instead of `getReplyFromConfig`
- explicit `/acp steer` command uses `mode: "steer"`

Outbound:

- ACP event stream is normalized to OpenClaw reply chunks
- delivery target is resolved through existing bound destination path
- when a bound thread is active for that session turn, parent channel completion is suppressed

Streaming policy:

- stream partial output with coalescing window
- configurable min interval and max chunk bytes to stay under Discord rate limits
- final message always emitted on completion or failure

### State machines and transaction boundaries

Session state machine:

- `creating -> idle -> running -> idle`
- `running -> cancelling -> idle | error`
- `idle -> closed`
- `error -> idle | closed`

Run state machine:

- `queued -> running -> completed`
- `running -> failed | cancelled`
- `queued -> cancelled`

Required transaction boundaries:

- spawn transaction
  - create ACP session row
  - create/update ACP thread binding row
  - enqueue initial run row
- close transaction
  - mark session closed
  - delete/expire binding rows
  - write final close event
- cancel transaction
  - mark target run cancelling/cancelled with idempotency key

No partial success is allowed across these boundaries.

### Per-session actor model

`AcpSessionManager` runs one actor per ACP session key:

- actor mailbox serializes `submit`, `cancel`, `close`, and `stream` side effects
- actor owns runtime handle hydration and runtime adapter process lifecycle for that session
- actor writes run events in-order (`seq`) before any Discord delivery
- actor updates delivery checkpoints after successful outbound send

This removes cross-turn races and prevents duplicate or out-of-order thread output.

### Idempotency and delivery projection

All external ACP actions must carry idempotency keys:

- spawn idempotency key
- prompt/steer idempotency key
- cancel idempotency key
- close idempotency key

Delivery rules:

- Discord messages are derived from `acp_events` plus `acp_delivery_checkpoint`
- retries resume from checkpoint without re-sending already delivered chunks
- final reply emission is exactly-once per run from projection logic

### Recovery and self-healing

On gateway start:

- load non-terminal ACP sessions (`creating`, `idle`, `running`, `cancelling`, `error`)
- recreate actors lazily on first inbound event or eagerly under configured cap
- reconcile any `running` runs missing heartbeats and mark `failed` or recover via adapter

On inbound Discord thread message:

- if binding exists but ACP session is missing, fail closed with explicit stale-binding message
- optionally auto-unbind stale binding after operator-safe validation
- never silently route stale ACP bindings to normal LLM path

### Lifecycle and safety

Supported operations:

- cancel current run: `/acp cancel`
- unbind thread: `/unfocus`
- close ACP session: `/acp close`
- auto close idle sessions by effective TTL

TTL policy:

- effective TTL is minimum of
  - global/session TTL
  - Discord thread binding TTL
  - ACP runtime owner TTL

Safety controls:

- allowlist ACP agents by name
- restrict workspace roots for ACP sessions
- env allowlist passthrough
- max concurrent ACP sessions per account and globally
- bounded restart backoff for runtime crashes

## Config surface

Core keys:

- `acp.enabled`
- `acp.dispatch.enabled` (independent ACP routing kill switch)
- `acp.backend` (default `acpx`)
- `acp.defaultAgent`
- `acp.allowedAgents[]`
- `acp.maxConcurrentSessions`
- `acp.stream.coalesceIdleMs`
- `acp.stream.maxChunkChars`
- `acp.runtime.ttlMinutes`
- `acp.controlPlane.store` (`sqlite` default)
- `acp.controlPlane.storePath`
- `acp.controlPlane.recovery.eagerActors`
- `acp.controlPlane.recovery.reconcileRunningAfterMs`
- `acp.controlPlane.checkpoint.flushEveryEvents`
- `acp.controlPlane.checkpoint.flushEveryMs`
- `acp.idempotency.ttlHours`
- `channels.discord.threadBindings.spawnAcpSessions`

Plugin/backend keys (acpx plugin section):

- backend command/path overrides
- backend env allowlist
- backend per-agent presets
- backend startup/stop timeouts
- backend max inflight runs per session

## Implementation specification

### Control-plane modules (new)

Add dedicated ACP control-plane modules in core:

- `src/acp/control-plane/manager.ts`
  - owns ACP actors, lifecycle transitions, command serialization
- `src/acp/control-plane/store.ts`
  - SQLite schema management, transactions, query helpers
- `src/acp/control-plane/events.ts`
  - typed ACP event definitions and serialization
- `src/acp/control-plane/checkpoint.ts`
  - durable delivery checkpoints and replay cursors
- `src/acp/control-plane/idempotency.ts`
  - idempotency key reservation and response replay
- `src/acp/control-plane/recovery.ts`
  - boot-time reconciliation and actor rehydrate plan

Compatibility bridge modules:

- `src/acp/runtime/session-meta.ts`
  - remains temporarily for projection into `SessionEntry.acp`
  - must stop being source-of-truth after migration cutover

### Required invariants (must enforce in code)

- ACP session creation and thread bind are atomic (single transaction)
- there is at most one active run per ACP session actor at a time
- event `seq` is strictly increasing per run
- delivery checkpoint never advances past last committed event
- idempotency replay returns previous success payload for duplicate command keys
- stale/missing ACP metadata cannot route into normal non-ACP reply path

### Core touchpoints

Core files to change:

- `src/auto-reply/reply/dispatch-from-config.ts`
  - ACP branch calls `AcpSessionManager.submit` and event-projection delivery
  - remove direct ACP fallback that bypasses control-plane invariants
- `src/auto-reply/reply/inbound-context.ts` (or nearest normalized context boundary)
  - expose normalized routing keys and idempotency seeds for ACP control plane
- `src/config/sessions/types.ts`
  - keep `SessionEntry.acp` as projection-only compatibility field
- `src/gateway/server-methods/sessions.ts`
  - reset/delete/archive must call ACP manager close/unbind transaction path
- `src/infra/outbound/bound-delivery-router.ts`
  - enforce fail-closed destination behavior for ACP bound session turns
- `src/discord/monitor/thread-bindings.ts`
  - add ACP stale-binding validation helpers wired to control-plane lookups
- `src/auto-reply/reply/commands-acp.ts`
  - route spawn/cancel/close/steer through ACP manager APIs
- `src/agents/acp-spawn.ts`
  - stop ad-hoc metadata writes; call ACP manager spawn transaction
- `src/plugin-sdk/**` and plugin runtime bridge
  - expose ACP backend registration and health semantics cleanly

Core files explicitly not replaced:

- `src/discord/monitor/message-handler.preflight.ts`
  - keep thread binding override behavior as the canonical session-key resolver

### ACP runtime registry API

Add a core registry module:

- `src/acp/runtime/registry.ts`

Required API:

```ts
export type AcpRuntimeBackend = {
  id: string;
  runtime: AcpRuntime;
  healthy?: () => boolean;
};

export function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void;
export function unregisterAcpRuntimeBackend(id: string): void;
export function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null;
export function requireAcpRuntimeBackend(id?: string): AcpRuntimeBackend;
```

Behavior:

- `requireAcpRuntimeBackend` throws a typed ACP backend missing error when unavailable
- plugin service registers backend on `start` and unregisters on `stop`
- runtime lookups are read-only and process-local

### acpx runtime plugin contract (implementation detail)

For the first production backend (`extensions/acpx`), OpenClaw and acpx are
connected with a strict command contract:

- backend id: `acpx`
- plugin service id: `acpx-runtime`
- runtime handle encoding: `runtimeSessionName = acpx:v1:<base64url(json)>`
- encoded payload fields:
  - `name` (acpx named session; uses OpenClaw `sessionKey`)
  - `agent` (acpx agent command)
  - `cwd` (session workspace root)
  - `mode` (`persistent | oneshot`)

Command mapping:

- ensure session:
  - `acpx --format json --json-strict --cwd <cwd> <agent> sessions ensure --name <name>`
- prompt turn:
  - `acpx --format json --json-strict --cwd <cwd> <agent> prompt --session <name> --file -`
- cancel:
  - `acpx --format json --json-strict --cwd <cwd> <agent> cancel --session <name>`
- close:
  - `acpx --format json --json-strict --cwd <cwd> <agent> sessions close <name>`

Streaming:

- OpenClaw consumes ndjson events from `acpx --format json --json-strict`
- `text` => `text_delta/output`
- `thought` => `text_delta/thought`
- `tool_call` => `tool_call`
- `done` => `done`
- `error` => `error`

### Session schema patch

Patch `SessionEntry` in `src/config/sessions/types.ts`:

```ts
type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};
```

Persisted field:

- `SessionEntry.acp?: SessionAcpMeta`

Migration rules:

- phase A: dual-write (`acp` projection + ACP SQLite source-of-truth)
- phase B: read-primary from ACP SQLite, fallback-read from legacy `SessionEntry.acp`
- phase C: migration command backfills missing ACP rows from valid legacy entries
- phase D: remove fallback-read and keep projection optional for UX only
- legacy fields (`cliSessionIds`, `claudeCliSessionId`) remain untouched

### Error contract

Add stable ACP error codes and user-facing messages:

- `ACP_BACKEND_MISSING`
  - message: `ACP runtime backend is not configured. Install and enable the acpx runtime plugin.`
- `ACP_BACKEND_UNAVAILABLE`
  - message: `ACP runtime backend is currently unavailable. Try again in a moment.`
- `ACP_SESSION_INIT_FAILED`
  - message: `Could not initialize ACP session runtime.`
- `ACP_TURN_FAILED`
  - message: `ACP turn failed before completion.`

Rules:

- return actionable user-safe message in-thread
- log detailed backend/system error only in runtime logs
- never silently fall back to normal LLM path when ACP routing was explicitly selected

### Duplicate delivery arbitration

Single routing rule for ACP bound turns:

- if an active thread binding exists for the target ACP session and requester context, deliver only to that bound thread
- do not also send to parent channel for the same turn
- if bound destination selection is ambiguous, fail closed with explicit error (no implicit parent fallback)
- if no active binding exists, use normal session destination behavior

### Observability and operational readiness

Required metrics:

- ACP spawn success/failure count by backend and error code
- ACP run latency percentiles (queue wait, runtime turn time, delivery projection time)
- ACP actor restart count and restart reason
- stale-binding detection count
- idempotency replay hit rate
- Discord delivery retry and rate-limit counters

Required logs:

- structured logs keyed by `sessionKey`, `runId`, `backend`, `threadId`, `idempotencyKey`
- explicit state transition logs for session and run state machines
- adapter command logs with redaction-safe arguments and exit summary

Required diagnostics:

- `/acp sessions` includes state, active run, last error, and binding status
- `/acp doctor` (or equivalent) validates backend registration, store health, and stale bindings

### Config precedence and effective values

ACP enablement precedence:

- account override: `channels.discord.accounts.<id>.threadBindings.spawnAcpSessions`
- channel override: `channels.discord.threadBindings.spawnAcpSessions`
- global ACP gate: `acp.enabled`
- dispatch gate: `acp.dispatch.enabled`
- backend availability: registered backend for `acp.backend`

Auto-enable behavior:

- when ACP is configured (`acp.enabled=true`, `acp.dispatch.enabled=true`, or
  `acp.backend=acpx`), plugin auto-enable marks `plugins.entries.acpx.enabled=true`
  unless denylisted or explicitly disabled

TTL effective value:

- `min(session ttl, discord thread binding ttl, acp runtime ttl)`

### Test map

Unit tests:

- `src/acp/runtime/registry.test.ts` (new)
- `src/auto-reply/reply/dispatch-from-config.acp.test.ts` (new)
- `src/infra/outbound/bound-delivery-router.test.ts` (extend ACP fail-closed cases)
- `src/config/sessions/types.test.ts` or nearest session-store tests (ACP metadata persistence)

Integration tests:

- `src/discord/monitor/reply-delivery.test.ts` (bound ACP delivery target behavior)
- `src/discord/monitor/message-handler.preflight*.test.ts` (bound ACP session-key routing continuity)
- acpx plugin runtime tests in backend package (service register/start/stop + event normalization)

Gateway e2e tests:

- `src/gateway/server.sessions.gateway-server-sessions-a.e2e.test.ts` (extend ACP reset/delete lifecycle coverage)
- ACP thread turn roundtrip e2e for spawn, message, stream, cancel, unfocus, restart recovery

### Rollout guard

Add independent ACP dispatch kill switch:

- `acp.dispatch.enabled` default `false` for first release
- when disabled:
  - ACP spawn/focus control commands may still bind sessions
  - ACP dispatch path does not activate
  - user receives explicit message that ACP dispatch is disabled by policy
- after canary validation, default can be flipped to `true` in a later release

## Command and UX plan

### New commands

- `/acp spawn <agent-id> [--mode persistent|oneshot] [--thread auto|here|off]`
- `/acp cancel [session]`
- `/acp steer <instruction>`
- `/acp close [session]`
- `/acp sessions`

### Existing command compatibility

- `/focus <sessionKey>` continues to support ACP targets
- `/unfocus` keeps current semantics
- `/session ttl` remains the top level TTL override

## Phased rollout

### Phase 0 ADR and schema freeze

- ship ADR for ACP control-plane ownership and adapter boundaries
- freeze DB schema (`acp_sessions`, `acp_runs`, `acp_bindings`, `acp_events`, `acp_delivery_checkpoint`, `acp_idempotency`)
- define stable ACP error codes, event contract, and state-transition guards

### Phase 1 Control-plane foundation in core

- implement `AcpSessionManager` and per-session actor runtime
- implement ACP SQLite store and transaction helpers
- implement idempotency store and replay helpers
- implement event append + delivery checkpoint modules
- wire spawn/cancel/close APIs to manager with transactional guarantees

### Phase 2 Core routing and lifecycle integration

- route thread-bound ACP turns from dispatch pipeline into ACP manager
- enforce fail-closed routing when ACP binding/session invariants fail
- integrate reset/delete/archive/unfocus lifecycle with ACP close/unbind transactions
- add stale-binding detection and optional auto-unbind policy

### Phase 3 acpx backend adapter/plugin

- implement `acpx` adapter against runtime contract (`ensureSession`, `submit`, `stream`, `cancel`, `close`)
- add backend health checks and startup/teardown registration
- normalize acpx ndjson events into ACP runtime events
- enforce backend timeouts, process supervision, and restart/backoff policy

### Phase 4 Delivery projection and channel UX (Discord first)

- implement event-driven channel projection with checkpoint resume (Discord first)
- coalesce streaming chunks with rate-limit aware flush policy
- guarantee exactly-once final completion message per run
- ship `/acp spawn`, `/acp cancel`, `/acp steer`, `/acp close`, `/acp sessions`

### Phase 5 Migration and cutover

- introduce dual-write to `SessionEntry.acp` projection plus ACP SQLite source-of-truth
- add migration utility for legacy ACP metadata rows
- flip read path to ACP SQLite primary
- remove legacy fallback routing that depends on missing `SessionEntry.acp`

### Phase 6 Hardening, SLOs, and scale limits

- enforce concurrency limits (global/account/session), queue policies, and timeout budgets
- add full telemetry, dashboards, and alert thresholds
- chaos-test crash recovery and duplicate-delivery suppression
- publish runbook for backend outage, DB corruption, and stale-binding remediation

### Full implementation checklist

- core control-plane modules and tests
- DB migrations and rollback plan
- ACP manager API integration across dispatch and commands
- adapter registration interface in plugin runtime bridge
- acpx adapter implementation and tests
- thread-capable channel delivery projection logic with checkpoint replay (Discord first)
- lifecycle hooks for reset/delete/archive/unfocus
- stale-binding detector and operator-facing diagnostics
- config validation and precedence tests for all new ACP keys
- operational docs and troubleshooting runbook

## Test plan

Unit tests:

- ACP DB transaction boundaries (spawn/bind/enqueue atomicity, cancel, close)
- ACP state-machine transition guards for sessions and runs
- idempotency reservation/replay semantics across all ACP commands
- per-session actor serialization and queue ordering
- acpx event parser and chunk coalescer
- runtime supervisor restart and backoff policy
- config precedence and effective TTL calculation
- core ACP routing branch selection and fail-closed behavior when backend/session is invalid

Integration tests:

- fake ACP adapter process for deterministic streaming and cancel behavior
- ACP manager + dispatch integration with transactional persistence
- thread-bound inbound routing to ACP session key
- thread-bound outbound delivery suppresses parent channel duplication
- checkpoint replay recovers after delivery failure and resumes from last event
- plugin service registration and teardown of ACP runtime backend

Gateway e2e tests:

- spawn ACP with thread, exchange multi-turn prompts, unfocus
- gateway restart with persisted ACP DB and bindings, then continue same session
- concurrent ACP sessions in multiple threads have no cross-talk
- duplicate command retries (same idempotency key) do not create duplicate runs or replies
- stale-binding scenario yields explicit error and optional auto-clean behavior

## Risks and mitigations

- Duplicate deliveries during transition
  - Mitigation: single destination resolver and idempotent event checkpoint
- Runtime process churn under load
  - Mitigation: long lived per session owners + concurrency caps + backoff
- Plugin absent or misconfigured
  - Mitigation: explicit operator-facing error and fail-closed ACP routing (no implicit fallback to normal session path)
- Config confusion between subagent and ACP gates
  - Mitigation: explicit ACP keys and command feedback that includes effective policy source
- Control-plane store corruption or migration bugs
  - Mitigation: WAL mode, backup/restore hooks, migration smoke tests, and read-only fallback diagnostics
- Actor deadlocks or mailbox starvation
  - Mitigation: watchdog timers, actor health probes, and bounded mailbox depth with rejection telemetry

## Acceptance checklist

- ACP session spawn can create or bind a thread in a supported channel adapter (currently Discord)
- all thread messages route to bound ACP session only
- ACP outputs appear in the same thread identity with streaming or batches
- no duplicate output in parent channel for bound turns
- spawn+bind+initial enqueue are atomic in persistent store
- ACP command retries are idempotent and do not duplicate runs or outputs
- cancel, close, unfocus, archive, reset, and delete perform deterministic cleanup
- crash restart preserves mapping and resumes multi turn continuity
- concurrent thread bound ACP sessions work independently
- ACP backend missing state produces clear actionable error
- stale bindings are detected and surfaced explicitly (with optional safe auto-clean)
- control-plane metrics and diagnostics are available for operators
- new unit, integration, and e2e coverage passes

## Addendum: targeted refactors for current implementation (status)

These are non-blocking follow-ups to keep the ACP path maintainable after the current feature set lands.

### 1) Centralize ACP dispatch policy evaluation (completed)

- implemented via shared ACP policy helpers in `src/acp/policy.ts`
- dispatch, ACP command lifecycle handlers, and ACP spawn path now consume shared policy logic

### 2) Split ACP command handler by subcommand domain (completed)

- `src/auto-reply/reply/commands-acp.ts` is now a thin router
- subcommand behavior is split into:
  - `src/auto-reply/reply/commands-acp/lifecycle.ts`
  - `src/auto-reply/reply/commands-acp/runtime-options.ts`
  - `src/auto-reply/reply/commands-acp/diagnostics.ts`
  - shared helpers in `src/auto-reply/reply/commands-acp/shared.ts`

### 3) Split ACP session manager by responsibility (completed)

- manager is split into:
  - `src/acp/control-plane/manager.ts` (public facade + singleton)
  - `src/acp/control-plane/manager.core.ts` (manager implementation)
  - `src/acp/control-plane/manager.types.ts` (manager types/deps)
  - `src/acp/control-plane/manager.utils.ts` (normalization + helper functions)

### 4) Optional acpx runtime adapter cleanup

- `extensions/acpx/src/runtime.ts` can be split into:
- process execution/supervision
- ndjson event parsing/normalization
- runtime API surface (`submit`, `cancel`, `close`, etc.)
- improves testability and makes backend behavior easier to audit
