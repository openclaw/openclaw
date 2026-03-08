---
summary: "Implementation checklist mapping the current OpenClaw x AOTUI codebase against the technical RFC"
owner: "codex"
status: "draft"
last_updated: "2026-03-07"
title: "OpenClaw x AOTUI Implementation Checklist"
---

# OpenClaw x AOTUI Implementation Checklist

## Purpose

This checklist maps the current codebase to `OPENCLAW_AOTUI_TECHNICAL_RFC.md`.

It is not a roadmap by itself.
It is an alignment ledger.

For each item, the checklist marks whether the current code is:

- `satisfied`
- `violates_rfc`
- `new_abstraction_required`
- `dead_code_deletable`

An item may carry more than one concern.
Example:

- a behavior may currently violate the RFC
- and the clean fix may require a new abstraction

## Reading guide

Status meanings:

- `satisfied`: current code already matches the RFC
- `violates_rfc`: current code behavior conflicts with the RFC
- `new_abstraction_required`: current code has no clean home for the required behavior
- `dead_code_deletable`: current code exists but should be removed if the team follows the RFC strictly

## Summary

### Already satisfied

- gateway-scoped runtime ownership exists
- desktops are session-key bound
- AOTUI is integrated through an adapter, not by taking over orchestration
- AOTUI tool execution is lock-mediated through the kernel
- injected runtime messages are replaceable and tagged

### Violates the RFC

- reset loses part of the identity packet
- messages and tools are sampled from different snapshot epochs
- app capability authority is still external to OpenClaw config
- runtime/system content is projected as user messages
- every configured app is installed into each desktop

### Requires new abstractions

- agent-first AOTUI policy resolver
- atomic turn projector
- explicit reinitialization coordinator
- projection budget policy

### Dead code deletable

- idle lifecycle surface, if the team chooses not to productize it now
- unused runtime config surface if it remains unwired

## Checklist

## 1. Runtime ownership

### 1.1 Gateway-scoped runtime service

- RFC reference: runtime service layer
- Current status: `satisfied`
- Evidence:
  - `src/gateway/server.impl.ts` starts the runtime once via `startAotuiGatewayRuntime()`
  - `src/aotui/runtime.ts` stores the singleton in `gatewayKernelService`
- Why this matters:
  - preserves continuity across runs
  - avoids one-runtime-per-run fragmentation
- Action:
  - keep

### 1.2 Runtime service remains subordinate to OpenClaw

- RFC reference: architectural thesis
- Current status: `satisfied`
- Evidence:
  - AOTUI is installed from `src/agents/pi-embedded-runner/run/attempt.ts`
  - no evidence that AOTUI owns the agent loop or transcript path
- Why this matters:
  - AOTUI must remain a runtime subsystem, not an orchestrator
- Action:
  - keep

## 2. Session and desktop identity

### 2.1 Canonical session key binds desktop identity

- RFC reference: desktop identity and session binding
- Current status: `satisfied`
- Evidence:
  - `src/aotui/session-desktop-manager.ts` normalizes and keys desktops by `sessionKey`
  - `toDesktopId()` derives the desktop id from normalized session key
- Why this matters:
  - stable continuity should bind to session identity, not run identity
- Action:
  - keep

### 2.2 Reset preserves full identity packet

- RFC reference: preserve identity packet on reset
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/runtime.ts` calls `resetDesktop(sessionKey, { sessionId, reason })`
  - `src/aotui/session-desktop-manager.ts` rebuilds with `ensureDesktop({ sessionKey, sessionId })`
  - `agentId` is therefore not preserved across reset
- Why this matters:
  - breaks future policy attribution and agent-scoped capability control
- Action:
  - change `resetDesktop()` to accept the full binding packet or reconstruct it before destroy/recreate

### 2.3 Workspace directory is not a required identity field

- RFC reference: desktop binding packet
- Current status: `satisfied`
- Evidence:
  - the current discussion explicitly rejected `workspaceDir` as a required continuity anchor in the OpenClaw-integrated model
- Why this matters:
  - prevents the architecture from smuggling a project-root assumption into a machine-scope model
- Action:
  - keep optional only

## 3. App capability authority

### 3.1 App installation source of truth lives in OpenClaw config

- RFC reference: config authority
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/kernel-service.ts` constructs `new AppRegistry()`
  - `src/aotui/kernel-service.ts` calls `this.appRegistry.loadFromConfig()`
- Why this matters:
  - capability authority is still partially external
  - this creates drift between OpenClaw policy and effective runtime surface
- Action:
  - route app policy through OpenClaw config and remove implicit external registry control

### 3.2 Agent-first app policy exists

- RFC reference: agent app policy
- Current status: `new_abstraction_required`
- Evidence:
  - there is no dedicated OpenClaw-side policy resolver for agent-to-app exposure
- Why this matters:
  - app exposure must be intentional and agent-scoped
- Action:
  - introduce `AotuiPolicyResolver` or equivalent

### 3.3 Only allowed apps are installed into a desktop

- RFC reference: install only what the agent is allowed to use
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/kernel-service.ts` calls `installAll(desktop, { dynamicConfig })`
- Why this matters:
  - installs every configured app
  - expands token surface and misuse surface needlessly
- Action:
  - replace `installAll()` behavior with explicit allowed-app installation

## 4. Turn projection and snapshot consistency

### 4.1 One model turn uses one snapshot epoch

- RFC reference: atomic turn projection
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/agent-adapter.ts` acquires a snapshot in `buildAotuiMessages()`
  - `src/aotui/agent-adapter.ts` acquires another snapshot in `buildAotuiTools()`
  - `refreshToolsAndContext()` and `buildAotuiMessages()` are separate calls in the transform path
- Why this matters:
  - lets tools and visible world diverge
- Action:
  - replace split sampling with one `AotuiTurnProjection`

### 4.2 Turn projection abstraction exists

- RFC reference: turn projection layer
- Current status: `new_abstraction_required`
- Evidence:
  - today there is a projector for messages/tools, but no first-class atomic turn projection object
- Why this matters:
  - the code has no explicit home for one-snapshot-per-turn semantics
- Action:
  - add `AotuiTurnProjector`

### 4.3 Injected runtime messages are replaceable and tagged

- RFC reference: runtime context must not silently accumulate
- Current status: `satisfied`
- Evidence:
  - `src/aotui/projector.ts` tags injected messages with `metadata.aotui`
  - `replaceAotuiInjectedMessages()` strips old injected messages before adding the latest ones
- Why this matters:
  - avoids duplicate runtime context accumulation in transformed request messages
- Action:
  - keep

## 5. Prompt and role semantics

### 5.1 Runtime/system content is not projected as user intent

- RFC reference: runtime instructions are not user intent
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/projector.ts` emits `structured.systemInstruction` with `role: "user"`
  - `src/aotui/projector.ts` emits `desktopState` with `role: "user"`
- Why this matters:
  - collapses user intent and runtime guidance into the same semantic layer
- Action:
  - project runtime/system content using a system-equivalent channel

### 5.2 Projection favors current relevant state over replay

- RFC reference: projection is current-state projection
- Current status: `partially_satisfied`
- Evidence:
  - current projector uses latest structured snapshot
  - but there is not yet an explicit projection budget layer
- Why this matters:
  - current-state projection is correct, but still unbudgeted
- Action:
  - keep projector strategy, add projection budget policy

### 5.3 Projection budget policy exists

- RFC reference: projection budget order
- Current status: `new_abstraction_required`
- Evidence:
  - no dedicated projection policy object exists
- Why this matters:
  - without a budget policy, token pressure will be handled too late and too indirectly
- Action:
  - add projection budget config and enforcement

## 6. Tool routing and execution

### 6.1 Tool calls route back into the AOTUI kernel through OpenClaw

- RFC reference: tool call routing
- Current status: `satisfied`
- Evidence:
  - `src/aotui/agent-adapter.ts` resolves projected bindings
  - acquires kernel lock
  - executes operation through `kernel.execute()`
- Why this matters:
  - preserves OpenClaw as the caller and AOTUI as the execution substrate
- Action:
  - keep

### 6.2 Tool routing depends on the active projection state

- RFC reference: one-turn-one-world consistency
- Current status: `partially_satisfied`
- Evidence:
  - binding cache exists in `src/aotui/agent-adapter.ts`
  - but cache rebuild still samples snapshots independently if binding missing
- Why this matters:
  - a stale or separately rebuilt binding map can drift from the messages shown to the model
- Action:
  - tie binding resolution to the atomic turn projection

## 7. Compaction-triggered reinitialization model

### 7.1 RFC stance: compaction may reinitialize desktop apps

- RFC reference: compaction model
- Current status: `not_implemented_but_intended`
- Evidence:
  - the RFC and design principles now explicitly define this behavior
  - current code does not yet expose an OpenClaw-side reinitialization coordinator for AOTUI state
- Why this matters:
  - this is the core operating model for long-running sessions
- Action:
  - implement explicitly, do not leave it implicit

### 7.2 Dedicated AOTUI reinitialization coordinator exists

- RFC reference: `AotuiReinitializationCoordinator`
- Current status: `new_abstraction_required`
- Evidence:
  - no such abstraction exists in the current codebase
- Why this matters:
  - reinitialization semantics need a real home, not scattered ad hoc hooks
- Action:
  - add coordinator and integrate it into compaction flow

### 7.3 Current implementation preserves full AOTUI state across compaction by default

- RFC reference: AOTUI is a volatile scratchpad
- Current status: `violates_rfc_by_omission`
- Evidence:
  - there is no explicit app reinitialization path
  - there is no explicit post-compaction AOTUI policy hook
- Why this matters:
  - without explicit reinitialization, runtime state will accumulate until token pressure is paid indirectly
- Action:
  - implement explicit compaction-time app reinitialization semantics

## 8. Lifecycle and dead code

### 8.1 Idle lifecycle is a real subsystem

- RFC reference: idle lifecycle policy
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/session-desktop-manager.ts` defines `sweepIdle()`
  - search shows no production call site for `sweepIdle()`
  - only tests call it
- Why this matters:
  - the code advertises lifecycle behavior that the product does not actually run
- Action:
  - either wire a real scheduler or delete the idle lifecycle surface now

### 8.2 Idle lifecycle surface is deletable

- RFC reference: option A delete idle lifecycle now
- Current status: `dead_code_deletable`
- Evidence:
  - production code has idle lifecycle state and options without a real runtime driver
- Why this matters:
  - false lifecycle promises distort future debugging
- Action:
  - remove `idleSuspendMs`, `idleDestroyMs`, `sweepIdle()`, and `idle` status if not productized immediately

### 8.3 Idle state transitions are truthful

- RFC reference: truthful lifecycle states
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/session-desktop-manager.ts` sets status to `"suspended"` in `suspendDesktop()`
  - `sweepIdle()` then overwrites it to `"idle"`
  - `ensureDesktop()` only resumes when status is `"suspended"`
- Why this matters:
  - status machine semantics are internally inconsistent
- Action:
  - if lifecycle is kept, redesign the state model before shipping it

## 9. Runtime config surface

### 9.1 Unused runtime options remain exposed

- RFC reference: remove unused runtime config surface
- Current status: `violates_rfc`
- Evidence:
  - `src/aotui/types.ts` exposes `runtimeConfig`, `idleSuspendMs`, `idleDestroyMs`
  - no product-facing wiring exists for idle sweep
  - no clear OpenClaw-owned config story exists for these options
- Why this matters:
  - config surface without product semantics is ambiguity disguised as flexibility
- Action:
  - remove until a real product contract exists

### 9.2 Unused idle/runtime surface is deletable

- RFC reference: remove unused runtime config surface
- Current status: `dead_code_deletable`
- Evidence:
  - same evidence as above
- Why this matters:
  - deletion is cleaner than pretending future support
- Action:
  - delete if not activated in the next implementation phase

## 10. Observability

### 10.1 Projection and compaction observability is sufficient

- RFC reference: observability and diagnostics
- Current status: `violates_rfc`
- Evidence:
  - current code logs app installation
  - current code does not expose a dedicated per-turn AOTUI projection budget or snapshot-id observability surface
  - current code has no explicit compaction action logs for AOTUI state
- Why this matters:
  - the system cannot be operated confidently if token contribution and compaction behavior remain opaque
- Action:
  - add projection diagnostics and compaction diagnostics

### 10.2 Basic app-install logging exists

- RFC reference: observability foundation
- Current status: `satisfied`
- Evidence:
  - `src/aotui/kernel-service.ts` logs installed app ids and count
- Why this matters:
  - it is a useful but insufficient baseline
- Action:
  - keep and expand

## 11. App integration contract

### 11.1 App authors are forced to design for state loss

- RFC reference: app design rules
- Current status: `not_encoded_yet`
- Evidence:
  - the RFC now defines the rule
  - current code does not yet expose an explicit app-level reinitialization contract
- Why this matters:
  - without an encoded contract, future apps will accidentally depend on hidden state durability
- Action:
  - add documentation and possibly app/runtime hooks for compaction-aware apps

### 11.2 Hidden internal state is treated as non-durable

- RFC reference: only surfaced state is guaranteed to survive
- Current status: `conceptually_aligned_but_not_enforced`
- Evidence:
  - the architecture discussion now settles this principle
  - code does not yet enforce or expose it as an app contract
- Why this matters:
  - implicit assumptions will accumulate unless this is made explicit to app authors
- Action:
  - codify in app-facing integration docs and future SDK contract notes

## 12. Immediate deletion candidates

These are safe deletion candidates if the team chooses the RFC's "delete dead lifecycle now" path.

- `idleSuspendMs` option in `src/aotui/types.ts`
- `idleDestroyMs` option in `src/aotui/types.ts`
- `sweepIdle()` in `src/aotui/session-desktop-manager.ts`
- `idle` status in `DesktopRecordStatus` if no real idle scheduler is shipped

These should not be deleted only if the team commits to productizing lifecycle behavior immediately.

## 13. Required new abstractions

These abstractions do not exist cleanly today and should be introduced explicitly.

### 13.1 `AotuiPolicyResolver`

- Purpose:
  - resolve allowed apps and projection policy per agent
- Reason:
  - remove external control plane

### 13.2 `AotuiTurnProjector`

- Purpose:
  - acquire one snapshot epoch and produce one atomic projection
- Reason:
  - enforce one-turn-one-world

### 13.3 `AotuiReinitializationCoordinator`

- Purpose:
  - apply explicit AOTUI compaction-triggered reinitialization semantics
- Reason:
  - reinitialization needs a first-class home

### 13.4 Projection budget policy

- Purpose:
  - constrain message/tool projection before transcript pressure becomes pathological
- Reason:
  - context pressure is not transcript-only anymore

## 14. Upstream runtime dependencies

The following items are not blocked on OpenClaw-side cleanup, but they do require upstream runtime and/or SDK capabilities if the architecture is to remain clean long-term.

### 14.1 Desktop-level app reinitialization primitive

- Status: `upstream_runtime_required`
- RFC reference:
  - `OPENCLAW_AOTUI_TECHNICAL_RFC.md` section 18.1
- Why:
  - OpenClaw should be able to reinitialize desktop apps without destroying desktop identity

### 14.2 App-level reinitialization lifecycle hook

- Status: `upstream_runtime_required`
- RFC reference:
  - `OPENCLAW_AOTUI_TECHNICAL_RFC.md` section 18.2
- Why:
  - app authors need a formal way to cooperate with reinitialization

### 14.3 Host-owned explicit app installation API

- Status: `upstream_runtime_required`
- RFC reference:
  - `OPENCLAW_AOTUI_TECHNICAL_RFC.md` section 18.3
- Why:
  - capability surface must not depend on ambient global runtime config

## 15. Minimal implementation order

If the team wants the shortest path to RFC alignment, the order should be:

1. Fix reset identity preservation
2. Fix one-turn-one-snapshot projection
3. Move app exposure authority into OpenClaw config
4. Delete dead idle lifecycle code or fully productize it
5. Fix runtime/system role semantics
6. Introduce explicit AOTUI reinitialization coordinator
7. Add projection budget and diagnostics

This order is not aesthetic.
It is causal.

Until 1 to 5 are fixed, the system still contains architectural lies.

## 16. Definition of aligned implementation

The implementation is aligned with the RFC when:

- all `violates_rfc` items above are resolved
- all `dead_code_deletable` items are either removed or fully productized
- all `new_abstraction_required` items exist with real call sites
- no part of effective AOTUI capability policy remains outside OpenClaw authority
- compaction can explicitly reinitialize desktop apps without collapsing task continuity
