---
title: "Bindings Capability Architecture Plan"
summary: "Plan for keeping bindings as a small core capability while moving ACP-specific binding policy and app-server policy out of core"
author: "Bob"
created: "2026-03-17"
status: "in_progress"
last_updated: "2026-03-17"
---

# Bindings Capability Architecture Plan

Status: in progress

## Summary

The goal is not to move all ACP code out of core.

The goal is to make `bindings` a small core capability, keep the ACP session kernel in core, and move ACP-specific binding policy plus codex app server policy out of core.

That gives us a lightweight core without hiding core semantics behind plugin indirection.

## Current Conclusion

The current architecture should converge on this split:

- Core owns the generic binding capability.
- Core owns the generic ACP session kernel.
- Channel plugins own channel-specific binding semantics.
- ACP backend plugins own runtime protocol details.
- Product-level consumers like ACP configured bindings and the codex app server sit on top of the binding capability instead of hardcoding their own binding plumbing.

This is different from "everything becomes a plugin".

## Why This Changed

The current codebase already shows that there are really three different layers:

- binding and conversation ownership
- long-lived session and runtime-handle orchestration
- product-specific turn logic

Those layers should not all be forced into one runtime engine.

Today the duplication is mostly in the execution/control-plane shape, not in storage or binding plumbing:

- the main harness has its own turn engine
- ACP has its own session control plane
- the codex app server plugin path likely owns its own app-level turn engine outside this repo

The right move is to share the stable control-plane contracts, not to force all three into one giant executor.

## Verified Current State

### Generic binding pieces already exist

- `src/infra/outbound/session-binding-service.ts` already provides a generic binding store and adapter model.
- `src/plugins/conversation-binding.ts` already lets plugins request a conversation binding and stores plugin-owned binding metadata.
- `src/plugins/types.ts` already exposes plugin-facing binding APIs.
- `src/plugins/types.ts` already exposes the generic `inbound_claim` hook.

### ACP is only partially pluginified

- `src/channels/plugins/configured-binding-registry.ts` now owns generic configured binding compilation and lookup.
- `src/channels/plugins/binding-routing.ts` and `src/channels/plugins/binding-targets.ts` now own the generic route and target lifecycle seams.
- ACP now plugs into that seam through `src/channels/plugins/acp-configured-binding-consumer.ts` and `src/channels/plugins/acp-stateful-target-driver.ts`.
- `src/acp/persistent-bindings.lifecycle.ts` still owns configured ACP ensure and reset behavior.
- runtime-created plugin conversation bindings still use a separate path in `src/plugins/conversation-binding.ts`.

### Codex app server is already closer to the desired shape

From this repo's side, the codex app server path is much thinner:

- a plugin binds a conversation
- core stores that binding
- inbound dispatch targets the plugin's `inbound_claim` hook

What core does not provide for the codex app server path is an ACP-like shared session kernel. If the app server needs retries, long-lived runtime handles, cancellation, or session health logic, it must own that itself today.

## The Durable Split

### 1. Core Binding Capability

This should become the primary shared seam.

Responsibilities:

- canonical `ConversationRef`
- binding record storage
- configured binding compilation
- runtime-created binding storage
- fast binding lookup on inbound
- binding touch/unbind lifecycle
- generic dispatch handoff to the binding target

What core binding capability must not own:

- Discord thread rules
- Telegram topic rules
- Feishu chat rules
- ACP session orchestration
- codex app server business logic

### 2. Core Stateful Target Kernel

This is the small generic kernel for long-lived bound targets.

Responsibilities:

- ensure target ready
- run turn
- cancel turn
- close target
- reset target
- status and health
- persistence of target metadata
- retries and runtime-handle safety
- per-target serialization and concurrency

ACP is the first real implementation of this shape.

This kernel should stay in core because it is mandatory infrastructure and has strict startup, reset, and recovery semantics.

### 3. Channel Binding Providers

Each channel plugin should own the meaning of "this channel conversation maps to this binding rule".

Responsibilities:

- normalize configured binding targets
- normalize inbound conversations
- match inbound conversations against compiled bindings
- define channel-specific matching priority
- optionally provide binding description text for status and logs

This is where Discord channel vs thread logic, Telegram topic rules, and Feishu conversation rules belong.

### 4. Product Consumers

Bindings are a shared capability. Different products should consume it differently.

ACP configured bindings:

- compile config rules
- resolve a target session
- ensure the ACP session is ready through the ACP kernel

Codex app server:

- create runtime-requested bindings
- claim inbound messages through plugin hooks
- optionally adopt the shared stateful target contract later if it really needs long-lived session orchestration

Main harness:

- does not need to become "a binding product"
- may eventually share small lifecycle contracts, but it should not be forced into the same engine as ACP

## The Key Architectural Decision

The shared abstraction should be:

- `bindings` as the capability
- `stateful target drivers` as an optional lower-level contract

The shared abstraction should not be:

- "one runtime engine for main harness, ACP, and codex app server"

That would overfit very different systems into one executor.

## Stable Nouns

Core should understand only stable nouns.

The stable nouns are:

- `ConversationRef`
- `BindingRule`
- `CompiledBinding`
- `BindingResolution`
- `BindingTargetDescriptor`
- `StatefulTargetDriver`
- `StatefulTargetHandle`

ACP, codex app server, and future products should compile down to those nouns instead of leaking product-specific routing rules through core.

## Proposed Capability Model

### Binding capability

The binding capability should support both configured bindings and runtime-created bindings.

Required operations:

- compile configured bindings at startup or reload
- resolve a binding from an inbound `ConversationRef`
- create a runtime binding
- touch and unbind an existing binding
- dispatch a resolved binding to its target

### Binding target descriptor

A resolved binding should point to a typed target descriptor rather than ad hoc ACP- or plugin-specific metadata blobs.

The descriptor should be able to represent at least:

- plugin-owned inbound claim targets
- stateful target drivers

That means the same binding capability can support both:

- codex app server plugin-bound conversations
- ACP configured bindings

without pretending they are the same product.

### Stateful target driver

This is the reusable control-plane contract for long-lived bound targets.

Required operations:

- `ensureReady`
- `runTurn`
- `cancel`
- `close`
- `reset`
- `status`
- `health`

ACP should remain the first built-in driver.

If the codex app server later proves that it also needs durable session handles, it can either:

- use a driver that consumes this contract, or
- keep its own product-owned runtime if that remains simpler

That should be a product decision, not something forced by the binding capability.

## Why ACP Kernel Stays In Core

ACP's kernel should remain in core because session lifecycle, persistence, retries, cancellation, and runtime-handle safety are generic platform machinery.

Those concerns are not channel-specific, and they are not codex-app-server-specific.

If we move that machinery into an ordinary plugin, we create circular bootstrapping:

- channels need it during startup and inbound routing
- reset and recovery need it when plugins may already be degraded
- failure semantics become special-case core logic anyway

If we later wrap it in a "built-in capability module", that is still effectively core.

## What Should Move Out Of Core

The following should move out of ACP-shaped core code:

- channel-specific configured binding matching
- channel-specific binding target normalization
- channel-specific recovery UX
- ACP-specific route wrapping helpers as named ACP seams
- codex app server fallback policy beyond generic plugin-bound dispatch behavior

The following should stay:

- generic binding storage and dispatch
- generic ACP control plane
- generic stateful target driver contract

## Current Problems To Remove

### Residual cleanup is now small

Most ACP-era compatibility names are gone from the generic seam.

The remaining cleanup is smaller:

- `src/acp/persistent-bindings.ts` compatibility barrel can be deleted once tests stop importing it
- ACP-named tests and mocks can be renamed over time for consistency
- docs should stop describing already-removed ACP wrappers as if they still exist

### Configured binding implementation is still too monolithic

`src/channels/plugins/configured-binding-registry.ts` still mixes:

- registry compilation
- cache invalidation
- inbound matching
- materialization of binding targets
- session-key reverse lookup

That file is now generic, but still too large and too coupled.

### Runtime-created plugin bindings still use a separate stack

`src/plugins/conversation-binding.ts` is still a separate implementation path for plugin-created bindings.

That means configured bindings and runtime-created bindings share storage, but not one consistent capability layer.

### Generic registries still hardcode ACP as a built-in

`src/channels/plugins/configured-binding-consumers.ts` and `src/channels/plugins/stateful-target-drivers.ts` still import ACP directly.

That is acceptable for now, but the clean final shape is to keep ACP built in while registering it from a dedicated bootstrap point instead of wiring it inside the generic registry files.

## Target Contracts

### Channel binding provider contract

Conceptually, each channel plugin should support:

- `compileConfiguredBinding(binding, cfg) -> CompiledBinding | null`
- `resolveInboundConversation(event) -> ConversationRef | null`
- `matchInboundConversation(compiledBinding, conversation) -> BindingMatch | null`
- `describeBinding(compiledBinding) -> string | undefined`

### Binding capability contract

Core should support:

- `compileConfiguredBindings(cfg, plugins) -> CompiledBindingRegistry`
- `resolveBinding(conversationRef) -> BindingResolution | null`
- `createRuntimeBinding(target, conversationRef, metadata) -> BindingRecord`
- `touchBinding(bindingId)`
- `unbindBinding(bindingId | target)`
- `dispatchResolvedBinding(bindingResolution, inboundEvent)`

### Stateful target driver contract

Core should support:

- `ensureReady(targetRef, cfg)`
- `runTurn(targetRef, input)`
- `cancel(targetRef, reason)`
- `close(targetRef, reason)`
- `reset(targetRef, reason)`
- `status(targetRef)`
- `health(targetRef)`

## File-Level Transition Plan

### Keep

- `src/infra/outbound/session-binding-service.ts`
- `src/acp/control-plane/*`
- `extensions/acpx/*`

### Generalize

- `src/plugins/conversation-binding.ts`
  - fold runtime-created plugin bindings into the same generic binding capability instead of keeping a separate implementation stack
- `src/channels/plugins/configured-binding-registry.ts`
  - split into compiler, matcher, and session-key resolution modules with a thin facade
- `src/channels/plugins/types.adapters.ts`
  - finish removing ACP-era aliases after the deprecation window
- `src/plugin-sdk/conversation-runtime.ts`
  - export only the generic binding capability surfaces
- `src/acp/persistent-bindings.lifecycle.ts`
  - either become a generic stateful target driver consumer or be renamed to ACP driver-specific lifecycle code

### Shrink Or Delete

- `src/acp/persistent-bindings.ts`
  - delete the compatibility barrel once tests import the real modules directly
- `src/acp/persistent-bindings.resolve.ts`
  - keep only while ACP-specific compatibility helpers are still useful to internal callers
- ACP-named test files
  - rename over time once the behavior is stable and there is no risk of mixing behavioral and naming churn

## Recommended Refactor Order

### Completed groundwork

The current branch has already completed most of the first migration wave:

- stable generic binding nouns exist
- configured bindings compile through a generic registry
- inbound routing goes through generic binding resolution
- configured binding lookup no longer performs fallback plugin discovery
- ACP is expressed as a configured-binding consumer plus a built-in stateful target driver

The remaining work is cleanup and unification, not first-principles redesign.

### Phase 1: Freeze the nouns

Introduce and document the stable binding and target types:

- `ConversationRef`
- `CompiledBinding`
- `BindingResolution`
- `BindingTargetDescriptor`
- `StatefulTargetDriver`

Do this before more movement so the rest of the refactor has firm vocabulary.

### Phase 2: Promote bindings to a first-class core capability

Refactor the existing generic binding store into an explicit capability layer.

Requirements:

- runtime-created bindings stay supported
- configured bindings become first-class
- lookup becomes channel-agnostic

### Phase 3: Compile configured bindings at startup and reload

Move configured binding compilation off the inbound hot path.

Requirements:

- load enabled channel plugins once
- compile configured bindings once
- rebuild on config or plugin reload
- inbound path becomes pure registry lookup

### Phase 4: Expand the channel provider seam

Replace the ACP-specific adapter shape with a generic channel binding provider contract.

Requirements:

- channel plugins own normalization and matching
- core no longer knows channel-specific configured binding rules

### Phase 5: Re-express ACP as a binding consumer plus built-in stateful target driver

Move ACP configured binding policy to the new binding capability while keeping ACP runtime orchestration in core.

Requirements:

- ACP configured bindings resolve through the generic binding registry
- ACP target readiness uses the ACP driver contract
- ACP-specific naming disappears from generic binding code

### Phase 6: Finish residual ACP cleanup

Remove the last compatibility leftovers and stale naming.

Requirements:

- delete `src/acp/persistent-bindings.ts`
- rename ACP-named tests where that improves clarity without changing behavior
- keep docs synchronized with the actual generic seam instead of the earlier transition state

### Phase 7: Split the configured binding registry by responsibility

Refactor `src/channels/plugins/configured-binding-registry.ts` into smaller modules.

Suggested split:

- compiler module
- inbound matcher module
- session-key reverse lookup module
- thin public facade

Requirements:

- caching behavior remains unchanged
- matching behavior remains unchanged
- session-key resolution behavior remains unchanged

### Phase 8: Keep codex app server on the same binding capability

Do not force the codex app server into ACP semantics.

Requirements:

- codex app server keeps runtime-created bindings through the same binding capability
- inbound claim remains the default delivery path
- only adopt the stateful target driver seam if the app server truly needs long-lived target orchestration
- `src/plugins/conversation-binding.ts` stops being a separate binding stack and becomes a consumer of the generic binding capability

### Phase 9: Decouple built-in ACP registration from generic registry files

Keep ACP built in, but stop importing it directly from the generic registry modules.

Requirements:

- `src/channels/plugins/configured-binding-consumers.ts` no longer hardcodes ACP imports
- `src/channels/plugins/stateful-target-drivers.ts` no longer hardcodes ACP imports
- ACP still registers by default during normal startup
- generic registry files remain product-agnostic

### Phase 10: Remove ACP-shaped compatibility facades

Once all call sites are on the generic capability:

- delete ACP-shaped routing helpers
- delete hot-path plugin bootstrapping logic
- keep only thin compatibility exports if external plugins still need a deprecation window

## Success Criteria

The architecture is done when all of these are true:

- no inbound configured-binding resolution performs plugin discovery
- no channel-specific binding semantics remain in generic core binding code
- ACP still uses a core session kernel
- codex app server and ACP both sit on top of the same binding capability
- the binding capability can represent both configured and runtime-created bindings
- runtime-created plugin bindings do not use a separate implementation stack
- long-lived target orchestration is shared through a small core driver contract
- generic registry files do not import ACP directly
- ACP-era alias names are gone from the generic/plugin SDK surface
- the main harness is not forced into the ACP engine
- external plugins can use the same capability without internal imports

## Non-Goals

These are not goals of the remaining refactor:

- moving the ACP session kernel into an ordinary plugin
- forcing the main harness, ACP, and codex app server into one executor
- making every channel implement its own retry and session-safety logic
- keeping ACP-shaped naming in the long-term generic binding layer

## Bottom Line

The right 20-year split is:

- bindings are the shared core capability
- ACP session orchestration remains a small built-in core kernel
- channel plugins own binding semantics
- backend plugins own runtime protocol details
- product consumers like ACP configured bindings and codex app server build on the same binding capability without being forced into one runtime engine

That is the leanest core that still has honest boundaries.
