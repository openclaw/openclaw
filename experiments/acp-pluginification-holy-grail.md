# ACP Pluginification Holy Grail

Status: proposal

## Summary

The long-term goal is not to move all ACP code out of core. The long-term goal is to make core own only the generic ACP session kernel while channel plugins own channel-specific binding semantics and ACP runtime backend plugins own backend-specific runtime behavior. If we get that split right, the hot path becomes simple, fast, and durable: no plugin discovery during message handling, no channel-specific logic in core ACP code, and no duplicated session state machine in every channel.

## Why This Should Last

The parts of the system that change over time are not all equally volatile.

- Channel transport semantics change often.
- Runtime backend behavior changes often.
- Session lifecycle, persistence, retries, cancellation, and concurrency change slowly.

A durable architecture splits on those lines.

If we instead split by "everything ACP should be a plugin", we force each channel plugin to either duplicate the ACP session state machine or depend on a special plugin bootstrapping path that is more complicated than core. That is not a lightweight core; that is a hidden core disguised as plugin indirection.

## Core Principle

Core should understand only stable nouns, not specific channels.

The stable nouns are:

- `ConversationRef`
- `ConfiguredAcpBindingRule`
- `CompiledAcpBinding`
- `BindingResolution`
- `AcpSessionRef`
- `AcpRuntimeBackend`

Discord, Telegram, Feishu, and future channels should all compile down to those nouns.

## Target Architecture

### 1. Core ACP Kernel

Core keeps the generic ACP engine.

Responsibilities:

- session lifecycle
- persistence
- concurrency limits
- retry policy
- cancellation
- runtime-handle validation
- backend registry
- generic reset/reinitialize semantics

This is the code that should stay in core:

- `src/acp/control-plane/manager.core.ts`
- generic ACP session metadata/storage code
- generic runtime backend registry

What core must not know:

- Discord thread semantics
- Telegram topic semantics
- Feishu chat peculiarities
- channel-specific configured-binding matching rules

### 2. Channel ACP Binding Adapters

Each channel plugin owns the meaning of "this inbound conversation maps to this ACP binding".

Responsibilities:

- normalize configured binding target
- normalize inbound conversation into a canonical `ConversationRef`
- match configured bindings for that channel
- optionally describe binding/recovery UX for logs and status

This is the right home for:

- thread vs parent-channel handling
- topic handling
- account-specific conversation identity rules
- channel-specific matching priority

This is currently only partially true. Today `ChannelAcpBindingAdapter` only exposes matching helpers in `src/channels/plugins/types.adapters.ts:544-562`.

### 3. ACP Runtime Backend Plugins

Backend plugins own runtime protocol specifics only.

Responsibilities:

- ensure session
- run turn
- get status
- cancel
- close
- backend-specific doctor/reporting

This is the role of `acpx` today.

### 4. Compiled Binding Registry

Configured ACP bindings should be compiled at startup and on config/plugin reload, not discovered on the inbound hot path.

Responsibilities:

- walk configured ACP bindings once
- ask the owning channel plugin to normalize each binding target
- materialize `CompiledAcpBinding` entries
- index them by canonical `ConversationRef`
- expose a fast lookup API during inbound handling

This is the key piece that makes the design elegant.

Without it, core keeps doing workspace scans, catalog lookups, and snapshot plugin loads while handling messages. That is tolerable as a migration bridge, but it is not the final architecture.

## What The Final Split Should Feel Like

### Inbound Message Path

1. Channel plugin receives inbound event.
2. Channel plugin produces canonical `ConversationRef`.
3. Core binding registry resolves `BindingResolution` with no plugin discovery.
4. Core ACP kernel ensures or reuses the generic ACP session.
5. Backend plugin runs the turn.

### Configured Binding Compilation Path

1. Core loads enabled channel plugins at startup or reload.
2. Core iterates configured ACP bindings from config.
3. Core dispatches each binding to the owning channel ACP binding adapter.
4. Channel adapter returns a normalized binding descriptor.
5. Core stores it in a compiled registry.

### Reset/New Path

1. Channel command surface identifies the bound session or binding key.
2. Core ACP kernel performs generic close/reinitialize/reset.
3. Channel plugin does not rebuild lifecycle semantics itself.

This keeps the channel plugin responsible for "which session should this conversation use?" while core remains responsible for "how does a session safely live and die?"

## Why The ACP Kernel Should Not Become An Ordinary Plugin

In principle, the ACP kernel could be moved behind a privileged system-plugin abstraction. In practice, it should not be moved into an ordinary plugin.

An ordinary plugin is the wrong shape because:

- it must be discovered and loaded by the same plugin system it would be underpinning
- channels would depend on it during startup, reset, reload, and inbound routing
- failure semantics become circular: if the kernel plugin is broken, the plugin system itself now needs special-case handling to recover
- mandatory ordering, availability, and dependency wiring would reintroduce core semantics behind plugin indirection

So the clean architecture is:

- core kernel
- plugin-owned channel semantics
- plugin-owned runtime backends

Not:

- "everything is a plugin", except one plugin that behaves exactly like core

## The Current Gap

Today the system is in a halfway state.

Good:

- configured binding lookup and route wrapping are moving behind the plugin seam
- backend runtime concerns are already plugin-shaped

Still heavy in core:

- configured binding resolution logic in `src/channels/plugins/acp-bindings.ts`
- configured binding ensure/reset logic in `src/acp/persistent-bindings.lifecycle.ts`
- inbound call sites still directly call core helpers instead of a stable plugin-facing binding service
- the hot path still has migration scaffolding for plugin snapshot discovery

This is the right migration direction, but not the ideal destination.

## Holy Grail Contract

The eventual `ChannelAcpBindingAdapter` should be expanded from a matching helper into a true channel binding contract.

It should conceptually support:

- `compileConfiguredBinding(binding, cfg) -> CompiledAcpBinding | null`
- `resolveInboundConversation(event/context) -> ConversationRef`
- `matchInboundConversation(compiledBinding, conversation) -> BindingMatch | null`
- `describeBinding(binding) -> string` for logs/status/debugging

Core should then own:

- `resolveCompiledAcpBinding(conversationRef)`
- `ensureBindingSession(bindingResolution)`
- `resetBindingSession(bindingResolution)`

That is the durable split.

## Implementation Plan

### Phase 1: Freeze The Core Nouns

Introduce and document the stable internal types:

- `ConversationRef`
- `CompiledAcpBinding`
- `BindingResolution`
- `AcpBindingSessionIdentity`

Requirements:

- channel-agnostic
- serializable
- stable enough for persistence and tests

Why:

Until these nouns exist, the code will keep leaking Discord or Telegram semantics across layers.

### Phase 2: Add A Binding Compiler Service

Create a core service that compiles configured ACP bindings at startup and config/plugin reload.

Responsibilities:

- load enabled channel plugins once
- for each configured ACP binding, call the owning channel adapter
- build a compiled registry indexed by `ConversationRef`
- expose a fast `resolve(conversationRef)` API

Why:

This removes plugin discovery from the hot path and turns binding resolution into data lookup instead of runtime introspection.

### Phase 3: Expand `ChannelAcpBindingAdapter`

Replace the current minimal adapter with a compiler-friendly contract.

Current:

- `normalizeConfiguredBindingTarget`
- `matchConfiguredBinding`

Desired:

- configured binding compilation
- inbound conversation normalization
- match/priority semantics against compiled bindings

Why:

The plugin should own the semantic translation from its transport model into `ConversationRef`. Core should never need to rediscover that logic.

### Phase 4: Move Inbound Call Sites To The Compiled Registry

Refactor channel code so inbound handlers do not call binding resolution helpers that trigger snapshot plugin loading.

Instead:

- channel code produces `ConversationRef`
- core compiled registry resolves the binding
- core ACP kernel ensures the session

Why:

This is the point where the migration becomes structurally complete from the hot path perspective.

### Phase 5: Reduce `src/channels/plugins/acp-bindings.ts` To A Thin Facade Or Delete It

Once the compiler service exists, the current file should either disappear or become a compatibility facade over:

- compiler service
- compiled registry
- adapter contracts

Why:

Today that file is doing too many jobs:

- plugin snapshot discovery
- catalog/plugin-id scoping
- workspace scanning
- binding normalization
- binding matching
- session-key reverse resolution

That is not the final shape.

### Phase 6: Keep `persistent-bindings.lifecycle` Generic Or Rename It

`src/acp/persistent-bindings.lifecycle.ts` should survive only if it becomes purely generic binding-session lifecycle code.

Allowed responsibilities:

- generic ensure/reset/reinitialize
- state compatibility checks
- calls into the ACP kernel

Disallowed responsibilities:

- channel-specific target normalization
- channel-specific matching logic
- runtime plugin discovery

Why:

This is where lightweight core and durable semantics can coexist.

### Phase 7: Expose Stable SDK Surfaces

Promote the durable ACP binding surfaces into plugin SDK exports so external channel plugins do not need internal imports or special knowledge.

This should include:

- the channel ACP binding adapter contract
- canonical conversation/binding types
- any channel runtime helpers required for ACP-bound inbound flows

Why:

A design is not truly pluginified if only built-in channel code can use it cleanly.

## Success Criteria

The architecture is done when all of these are true:

- no inbound ACP binding resolution performs plugin discovery
- no workspace scanning happens on the message hot path
- core ACP code contains no Discord/Telegram/Feishu matching semantics
- channel plugins do not implement their own ACP session state machine
- backend plugins remain runtime-only
- startup and reload build a compiled binding registry once
- external channel plugins can participate without internal imports

## Non-Goals

These are not part of the holy grail:

- moving the ACP session kernel out of core
- making every channel own session persistence and retry logic
- making ACP runtime plugins understand channels
- turning the ACP kernel into an ordinary plugin

## Recommended Near-Term Sequence

If we continue iterating from the current branch, the best order is:

1. Introduce `ConversationRef` and `CompiledAcpBinding` explicitly.
2. Build a startup/reload compiled registry for configured ACP bindings.
3. Refactor Discord, Telegram, and Feishu inbound paths to use the compiled registry.
4. Shrink `src/channels/plugins/acp-bindings.ts` into compiler/registry helpers only.
5. Trim `src/acp/persistent-bindings.lifecycle.ts` down to generic binding-session lifecycle.
6. Export the durable ACP binding contract through the plugin SDK.

That gets us to the elegant end state without destabilizing the ACP kernel.

## Bottom Line

The 20-year architecture is:

- core owns the ACP kernel
- channel plugins own binding semantics
- backend plugins own runtime semantics
- startup compiles binding config into a fast generic registry

That is the simplest design that keeps core lightweight without making the system fragile.
