Temporary internal migration note: remove this document once the extension-host migration is complete.

# OpenClaw Capability Catalog And Arbitration Spec

Date: 2026-03-15

## Purpose

This document defines how the system compiles agent-visible, operator-visible, and runtime-internal catalogs from active contributions and how it resolves conflicting or parallel providers.

The kernel should expose canonical actions, not raw plugin identities.

Host-managed install, onboarding, and lightweight channel catalogs remain separate from the kernel capability catalog.

## TODOs

- [ ] Implement kernel-owned internal and agent-visible catalogs.
- [ ] Implement host-owned operator catalogs and static setup catalogs.
- [ ] Implement canonical action registration and review workflow in code.
- [ ] Implement arbitration and conflict handling for at least one multi-provider family.
- [ ] Migrate the existing tool, provider, setup, and slot-selection surfaces so they no longer act as parallel catalog or arbitration systems.
- [ ] Record pilot parity for `thread-ownership` first and `telegram` second before broader catalog publication.
- [ ] Track which current `main` actions have been mapped into canonical action ids.

## Implementation Status

Current status against this spec:

- canonical catalogs and arbitration have not started
- only the earliest host-managed static metadata work has landed

What has been implemented:

- an initial Phase 0 cutover inventory now exists in `src/extension-host/cutover-inventory.md`
- channel catalog package metadata parsing now routes through host-owned schema helpers
- host-owned resolved-extension records now carry the static metadata needed for install, onboarding, and lightweight operator UX
- config doc baseline generation now uses the same host-owned resolved-extension metadata path
- plugin SDK alias resolution now routes through `src/extension-host/loader-compat.ts`
- loader alias-wired module loader creation now routes through `src/extension-host/loader-module-loader.ts`
- loader cache key construction and registry cache control now route through `src/extension-host/loader-cache.ts`
- loader lazy runtime proxy creation now routes through `src/extension-host/loader-runtime-proxy.ts`
- loader provenance helpers now route through `src/extension-host/loader-provenance.ts`
- loader duplicate-order and record/error policy now route through `src/extension-host/loader-policy.ts`
- loader discovery policy outcomes now route through `src/extension-host/loader-discovery-policy.ts`
- loader initial candidate planning and record creation now route through `src/extension-host/loader-records.ts`
- loader entry-path opening and module import now route through `src/extension-host/loader-import.ts`
- loader module-export resolution, config validation, and memory-slot load decisions now route through `src/extension-host/loader-runtime.ts`
- loader post-import planning and `register(...)` execution now route through `src/extension-host/loader-register.ts`
- loader per-candidate orchestration now routes through `src/extension-host/loader-flow.ts`
- loader top-level load orchestration now routes through `src/extension-host/loader-orchestrator.ts`
- loader execution setup composition now routes through `src/extension-host/loader-execution.ts`
- loader discovery and manifest bootstrap now routes through `src/extension-host/loader-bootstrap.ts`
- loader mutable activation state now routes through `src/extension-host/loader-session.ts`
- loader session run and finalization composition now routes through `src/extension-host/loader-run.ts`
- loader activation policy outcomes now route through `src/extension-host/loader-activation-policy.ts`
- loader record-state transitions now route through `src/extension-host/loader-state.ts`, which now enforces an explicit loader lifecycle state machine while preserving compatibility `PluginRecord.status` values
- loader finalization policy results now route through `src/extension-host/loader-finalization-policy.ts`
- loader final cache, readiness promotion, and activation finalization now routes through `src/extension-host/loader-finalize.ts`
- channel, provider, gateway-method, tool, CLI, service, command, context-engine, and hook registration normalization now has a host-owned helper boundary for future catalog migration

How it has been implemented:

- by moving package metadata parsing behind `src/extension-host/schema.ts`
- by keeping the existing catalog behavior intact while shifting metadata ownership into normalized host-owned records
- by reusing the resolved-extension registry for static operator/documentation surfaces instead of creating separate metadata caches
- by beginning runtime registration migration with host-owned normalization helpers before attempting full canonical catalog publication
- by moving cache-key construction and registry cache control behind host-owned helpers before attempting canonical catalog publication
- by beginning loader-path migration with host-owned compatibility, candidate-planning, import-flow, policy, runtime, register-flow, candidate-orchestration, top-level load orchestration, record-state with compatibility lifecycle mapping, and finalization helpers before attempting canonical catalog publication
- by extracting lazy runtime proxy creation and alias-wired Jiti module-loader creation into host-owned helpers before catalog publication work
- by extracting discovery, manifest loading, manifest diagnostics, discovery-policy logging, provenance building, and candidate ordering into a host-owned loader-bootstrap helper before catalog publication work
- by extracting candidate iteration, manifest lookup, per-candidate session processing, and finalization handoff into a host-owned loader-run helper before catalog publication work
- by converting the compatibility record-state layer into an enforced loader lifecycle state machine before catalog publication work
- by extracting runtime creation, registry creation, bootstrap setup, module-loader creation, and session creation into a host-owned loader-execution helper before catalog publication work
- by moving mutable activation state into a host-owned loader session before catalog publication work
- by extracting shared provenance path matching and install-rule evaluation into `src/extension-host/loader-provenance.ts` so activation and finalization policy seams reuse one host-owned implementation
- by turning open-allowlist discovery warnings into explicit host-owned discovery-policy results before catalog publication work
- by moving duplicate precedence, config enablement, and early memory-slot gating into explicit host-owned activation-policy outcomes before catalog publication work
- by turning provenance-based untracked-extension warnings and final memory-slot warnings into explicit host-owned finalization-policy results before catalog publication work

What remains pending:

- canonical capability ids
- runtime-derived kernel catalogs
- host-owned operator catalogs beyond the existing lightweight static paths
- arbitration modes and selection logic
- tool/provider/slot migration into one canonical catalog and arbitration model

## Goals

- agents see a stable, context-aware catalog of what they can do
- multiple active providers for the same functional area are supported
- collisions are detected and resolved deterministically
- operator commands and runtime backends stay separate from agent tools
- the catalog covers the broader current action surface, not only send and reply
- slot-backed providers such as context engines are selected explicitly
- setup and install metadata stay in host-managed catalogs instead of leaking into runtime catalogs

## Migration Framing

This spec replaces existing partial catalog and arbitration behavior already present on `main`.

It is not a standalone greenfield system.

Current behavior already exists in at least these places:

- agent-visible plugin tool grouping in `src/gateway/server-methods/tools-catalog.ts:71`
- provider auth and setup selection in `src/commands/auth-choice.apply.plugin-provider.ts:106`
- slot selection in `src/plugins/slots.ts:39`
- channel picker and onboarding metadata in `src/channels/plugins/catalog.ts:26`

Implementation rule:

- Phase 5 and Phase 6 are only complete when those legacy paths have been absorbed into the canonical or host-owned catalog model rather than left as a second source of truth

## Catalog Types

The system should maintain separate catalogs for:

- agent-visible capabilities
- operator-visible capabilities
- runtime-internal providers

These catalogs may draw from the same contributions but have different visibility and arbitration rules.

Ownership split:

- the kernel publishes runtime-derived internal and agent-visible catalogs
- the extension host publishes operator-visible catalogs, including host-only surfaces and any runtime-derived entries the operator surface needs

## Host-Managed Setup And Install Catalogs

Current `main` also has host-managed metadata that is not a kernel capability catalog:

- install metadata from `src/plugins/install.ts:48`
- channel picker and onboarding metadata from `src/channels/plugins/catalog.ts:26`
- lightweight shared channel behavior from `src/channels/dock.ts:228`

The extension host should keep publishing these static catalogs for setup and operator UX.

They should not be folded into the agent capability catalog.

This host-managed layer should also publish:

- local operator CLI commands from `surface.cli`
- setup and onboarding flows from `surface.setup`
- static channel picker metadata and lightweight dock-derived operator hints without activating heavy runtimes

Sequencing rule:

- these host-managed static catalogs should migrate before broad runtime catalog publication because they depend on static metadata, not heavy activation

## Canonical Capability Model

Each catalog entry should contain:

- `capabilityId`
- `kind`
- `canonicalAction`
- `displayName`
- `description`
- `providerKey`
- `scope`
- `availability`
- `requiresSelection`
- `inputSchema`
- `outputSchema`
- `policy`
- `telemetryTags`

### `capabilityId`

Stable runtime id for the contribution-backed capability.

### `canonicalAction`

A stable action family such as:

- `message.send`
- `message.reply`
- `directory.lookup`
- `provider.authenticate`
- `provider.configure`
- `memory.search`
- `memory.store`
- `message.broadcast`
- `message.poll`
- `message.react`
- `message.edit`
- `message.delete`
- `message.pin`
- `message.thread.manage`
- `voice.call.start`
- `diff.render`

The agent planner reasons over canonical actions first.

Governance decision:

- canonical action ids are open, namespaced strings
- core action families should still live in one source-of-truth registry in code
- if a new capability fits an existing family, reuse it
- if semantics are new, add a reviewed canonical action id to that registry
- contributions may not define new arbitration modes or planner semantics outside the core catalog and arbitration schema

### `providerKey`

Identifies the concrete provider instance behind the action.

Examples:

- `messaging:slack:work`
- `messaging:telegram:personal`
- `memory:lancedb:default`
- `runtime-backend:acp:acpx`

## Visibility Rules

### Agent-visible

Used for agent planning and tool calling.

Includes:

- agent tools
- channel messaging actions such as send, reply, broadcast, poll, react, edit, delete, pin, and thread actions when available in context
- memory actions when policy allows them
- voice or telephony actions
- selected interaction or workflow actions

### Operator-visible

Used for admin, control, setup, CLI, and diagnostic surfaces.

Includes:

- control commands
- setup flows
- provider integration and auth flows
- status surfaces
- CLI commands

Important distinction:

- `capability.control-command` is for chat or native commands that bypass the model
- `surface.cli` and `surface.setup` are host-managed local operator surfaces and are not kernel runtime capabilities

Operator-visible control-command surfaces should preserve current command metadata such as:

- whether the command accepts arguments
- provider-specific native command names when a provider supports native slash or menu registration

### Runtime-internal

Not shown to agents or operators as catalog actions.

Includes:

- runtime backends
- context engines
- pure event observers
- route augmenters

## Conflict Classes

The host must resolve different conflict types differently.

### 1. Runtime id conflict

Fatal during validation.

### 2. Canonical action overlap

Multiple providers implement the same action family.

This is expected for messaging, auth, or directory.

### 3. Planner-visible name collision

Two agent-visible capabilities want the same public name.

This must be resolved before catalog publication.

### 4. Singleton slot conflict

Two contributions claim a slot that is intentionally exclusive.

Examples:

- default memory backend
- default context engine

### 5. Route surface conflict

Two contributions require the same target or routing ownership semantics.

### 6. Backend selector conflict

Two runtime backends claim the same selector with incompatible exclusivity.

## Arbitration Modes

### `exclusive`

Exactly one active provider may exist for the slot.

Examples:

- one default context engine
- one default memory store, unless the operator opts into parallel memory providers

### `ranked`

Many providers may exist, but one default is chosen by rank.

Examples:

- multiple auth methods for one provider
- multiple backends for the same subsystem

### `parallel`

Many providers may remain simultaneously available.

Examples:

- Slack, Discord, and Telegram messaging providers for the same agent
- multiple directory sources

### `composed`

Many providers contribute to a single pipeline.

Examples:

- context augmentation
- prompt guidance
- telemetry enrichment

## Agent Catalog Compilation

The kernel compiles the agent-visible catalog from:

- active contributions
- current workspace
- current agent
- active session bindings
- route and account context
- current adapter action support
- policy restrictions
- contribution visibility rules

Catalog compilation is context-sensitive.

The same agent may see different capability sets in:

- Slack thread context
- Telegram DM context
- voice call context
- local CLI session

First-cut migration targets:

- plugin tools currently exposed by plugin grouping
- messaging actions for the first channel pilot
- route-affecting behaviors that influence whether an action is available at all

## Capability Selection Rules

When the agent or runtime needs one provider for a canonical action, selection should use this order:

1. explicit target or provider selector
2. explicit session binding
3. current conversation or thread route binding
4. current adapter or account capability support
5. policy-forced default
6. ranked default provider
7. deterministic fallback by extension id and contribution id

This is especially important for `message.send` and `message.reply`.

## Messaging Example

One agent may have:

- Discord adapter on work account
- Slack adapter on work account
- Telegram adapter on personal account

The agent should not see three unrelated tools named “send message”.

Instead it should see canonical action families, with provider resolution handled by:

- current conversation route
- current session binding
- explicit target selector when needed

Examples:

- `message.send`
- `message.reply`
- `message.broadcast`
- `message.poll`
- `message.react`

If disambiguation is required, the planner or runtime can use structured selectors such as:

- target channel kind
- account id
- conversation ref

## Agent Naming Rules

Agent-visible names must be stable and minimally ambiguous.

Rules:

- canonical names belong to action families
- provider labels are attached only when needed for disambiguation
- aliases do not create additional planner-visible tools unless explicitly requested
- the host rejects duplicate planner-visible names when the runtime cannot disambiguate them

This avoids exposing raw extension names unless necessary.

## Operator Command Separation

Control commands are not agent tools.

Examples today:

- `src/plugins/commands.ts:1`
- `extensions/phone-control/index.ts:330`

They belong only in operator catalogs and control surfaces.

## Provider Integration Selection

Provider integration flows should be modeled as operator-visible capabilities, not agent-visible tools.

Selection rules:

- provider id first
- method id second
- rank or policy third

Multiple auth methods for one provider may coexist.

The selected provider integration may also contribute:

- discovery order
- onboarding metadata
- token refresh behavior
- model-selected hooks

## Memory Arbitration

Memory needs both backend arbitration and agent action arbitration.

### Backend arbitration

Usually `exclusive` or `ranked`.

### Agent action arbitration

May still expose:

- `memory.search`
- `memory.store`

If parallel memory providers are enabled, the planner should either target the default store or use explicit selectors.

## Context Engine Arbitration

Context engines are runtime-internal providers selected through an explicit exclusive slot.

Selection rules:

- explicit configured engine id wins
- otherwise use the slot default
- if the selected engine is unavailable, fail with a typed configuration error rather than silently picking an arbitrary fallback

## Runtime Backend Arbitration

Runtime backends such as ACP are runtime-internal providers.

Selection rules:

- explicit backend id wins
- otherwise use healthy highest-ranked backend
- if a subsystem declares an exclusive slot, the host enforces it before kernel startup

This is why `capability.runtime-backend` must be a first-class family.

## Catalog Publication

The kernel should publish:

- a full internal catalog
- a filtered agent catalog

The extension host should publish:

- a filtered operator catalog

Publication should occur after:

- dependency resolution
- policy approval
- contribution activation
- route and account context binding

Host-managed install and onboarding descriptors may move into host ownership earlier because they come from static metadata, not runtime activation.

Full catalog publication, consolidation, and legacy-path replacement still belong to the catalog-migration phase.

Performance requirement:

- publishing host-managed setup and install catalogs must not require activating heavy adapter runtimes
- publishing operator-visible static catalogs must preserve current dock-style cheap-path behavior, including prompt hints and shared formatting helpers where those are consumed without runtime activation

## Telemetry And Auditing

Capability selection must emit structured events for:

- conflict detection
- provider selection
- fallback selection
- planner-visible disambiguation
- veto or cancellation caused by route augmenters
- slot selection for context engines or other exclusive runtime providers

## Migration Mapping From Today

- channel capabilities from `extensions/discord/src/channel.ts:74`, `extensions/slack/src/channel.ts:107`, and `extensions/telegram/src/channel.ts:120` collapse into canonical messaging action families
- diffs becomes an agent-visible tool family plus a host-managed route surface from `extensions/diffs/index.ts:27`
- provider integration from `extensions/google-gemini-cli-auth/index.ts:24` becomes operator-visible setup and auth capabilities
- voice-call from `extensions/voice-call/index.ts:230` becomes a mix of agent-visible actions, runtime providers, and operator surfaces
- ACP backend registration from `extensions/acpx/src/service.ts:55` becomes runtime-internal backend arbitration
- context-engine registration becomes runtime-internal slot arbitration from `src/context-engine/registry.ts:60`
- native command registration remains an operator or transport surface concern rather than an agent-visible catalog concern

## Immediate Implementation Work

1. Add canonical action ids and provider keys to resolved contributions.
2. Implement host-side conflict detection for planner-visible names and singleton slots.
3. Implement kernel-side context-aware catalog compilation.
4. Add host-managed static catalogs for install and onboarding metadata alongside the runtime catalogs.
5. Migrate the existing plugin tool grouping path onto canonical agent catalog entries.
6. Migrate the existing provider auth and setup selection path onto host-owned setup catalogs and canonical provider metadata.
7. Add provider selection logic for the broader messaging action family before migrating all channels.
8. Add runtime-backend and context-engine arbitration using the same rank and slot model where appropriate.
9. Ensure lightweight setup catalogs can be built from static descriptors alone.
10. Add a reviewed core registry for canonical action families and document how new ids are introduced.
11. Record catalog and arbitration parity for `thread-ownership` first and `telegram` second before broader rollout.
