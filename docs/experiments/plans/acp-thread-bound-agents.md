---
summary: "Integrate ACP coding agents into Discord thread bound sessions with a hybrid core router plus plugin-backed acpx runtime"
owner: "onutc"
status: "draft"
last_updated: "2026-02-22"
title: "ACP Thread Bound Agents"
---

# ACP Thread Bound Agents

## Overview

This plan defines how OpenClaw should support ACP coding agents in Discord threads with production level lifecycle and recovery.

Target user experience:

- a user spawns or focuses an ACP session into a Discord thread
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

## Why not pure plugin only

Current plugin hooks are not sufficient for end to end ACP session routing without core changes.

- inbound routing from Discord thread binding resolves to a session key in core dispatch first
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
- persisted ACP session metadata on OpenClaw sessions
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

Add a core ACP runtime contract so routing code does not depend on CLI details:

```ts
export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
};

export interface AcpRuntime {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<AcpRuntimeHandle>;

  submit(input: {
    handle: AcpRuntimeHandle;
    text: string;
    mode: AcpRuntimePromptMode;
    requestId: string;
  }): Promise<void>;

  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;

  close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void>;
}
```

Implementation detail:

- first backend: `AcpxRuntime` shipped as a plugin service
- core resolves runtime via registry and fails with explicit operator error when no ACP runtime backend is available

### Session data model

Add typed ACP metadata to OpenClaw session entries:

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

- metadata is persisted with session entry
- process ids and sockets stay in memory only
- if runtime owner dies, gateway lazily rehydrates on next user message

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
- `acp.backend` (default `acpx`)
- `acp.defaultAgent`
- `acp.allowedAgents[]`
- `acp.maxConcurrentSessions`
- `acp.stream.batchMs`
- `acp.stream.maxChunkChars`
- `acp.runtime.ttlMinutes`
- `channels.discord.threadBindings.spawnAcpSessions`

Plugin/backend keys (acpx plugin section):

- backend command/path overrides
- backend env allowlist
- backend per-agent presets

## Command and UX plan

### New commands

- `/acp spawn agent:<id> mode:<persistent|oneshot> thread:<auto|here>`
- `/acp cancel [session]`
- `/acp steer <instruction>`
- `/acp close [session]`
- `/acp sessions`

### Existing command compatibility

- `/focus <sessionKey>` continues to support ACP targets
- `/unfocus` keeps current semantics
- `/session ttl` remains the top level TTL override

## Phased rollout

### Phase 1 Core routing foundation

- add ACP session metadata persistence
- add ACP dispatch branch in core reply pipeline
- add ACP runtime registry contract in core
- add explicit error path when no ACP backend registered
- keep existing thread binding behavior unchanged

### Phase 2 acpx plugin backend

- implement `AcpxRuntime` as plugin service
- register ACP backend with core runtime registry
- route bound thread messages to ACP prompt
- send coarse batched outputs in thread
- ship `/acp spawn` and `/acp cancel`

### Phase 3 Hardening and polish

- streaming coalescer with idempotent checkpoints
- bounded runtime restart and structured error surfacing
- add `/acp steer` and `/acp close`
- enforce concurrency and workspace guardrails
- telemetry for queue depth, latency, restart count, and error classes

## Test plan

Unit tests:

- acpx event parser and chunk coalescer
- request id idempotency and duplicate suppression
- runtime supervisor restart and backoff policy
- config precedence and effective TTL calculation
- core ACP routing branch selection and fallback when backend is absent

Integration tests:

- fake ACP adapter process for deterministic streaming and cancel behavior
- thread bound inbound routing to ACP session key
- thread bound outbound delivery suppresses parent channel duplication
- plugin service registration and teardown of ACP runtime backend

Gateway e2e tests:

- spawn ACP with thread, exchange multi turn prompts, unfocus
- gateway restart with persisted binding and ACP metadata, then continue same session
- concurrent ACP sessions in multiple threads have no cross talk

## Risks and mitigations

- Duplicate deliveries during transition
  - Mitigation: single destination resolver and idempotent event checkpoint
- Runtime process churn under load
  - Mitigation: long lived per session owners + concurrency caps + backoff
- Plugin absent or misconfigured
  - Mitigation: explicit operator-facing error and safe fallback to normal session behavior
- Config confusion between subagent and ACP gates
  - Mitigation: explicit ACP keys and command feedback that includes effective policy source

## Acceptance checklist

- ACP session spawn can create or bind a Discord thread
- all thread messages route to bound ACP session only
- ACP outputs appear in the same thread identity with streaming or batches
- no duplicate output in parent channel for bound turns
- cancel, close, unfocus, archive, reset, and delete perform deterministic cleanup
- crash restart preserves mapping and resumes multi turn continuity
- concurrent thread bound ACP sessions work independently
- ACP backend missing state produces clear actionable error
- new unit, integration, and e2e coverage passes
