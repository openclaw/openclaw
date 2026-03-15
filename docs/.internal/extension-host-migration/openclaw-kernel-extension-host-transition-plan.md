Temporary internal migration note: remove this document once the extension-host migration is complete.

# OpenClaw Kernel + Extension Host Transition Plan

Date: 2026-03-15

## Purpose

This document defines a stricter transition plan for OpenClaw:

- the kernel must contain no plugin-specific code
- bundled extensions must be treated the same as externally installed extensions
- agents must see a clean, canonical catalog of what they can do
- conflicts and parallel providers must be handled explicitly, including multiple active messaging channels for the same agent
- the plan must preserve current functionality such as onboarding metadata, slot-backed providers, and transcript-write hooks

This is a stricter target than the earlier universal adapter plan. The earlier plan still kept plugin-shaped compatibility concerns too close to core. This version moves those concerns into an extension host layer outside the kernel.

## TODOs

- [ ] Confirm the implementation phase order still matches current repo priorities and staffing.
- [x] Write the initial boundary cutover inventory for every current plugin-owned surface.
- [ ] Keep the boundary cutover inventory updated as surfaces move.
- [ ] Track which phase has started, is in progress, and is complete.
- [ ] Link each completed phase to the concrete PRs or commits that implemented it.
- [ ] Mark which legacy compatibility shims still exist and which have been removed.
- [ ] Define the detailed pilot migration matrix and parity gates before broader compatibility rollout.
- [ ] Record any intentional scope cuts from the original transition sequence.

## Implementation Status

Current status against this transition plan:

- Phase 0 has started but is not complete.
- Phase 1 has started but is not complete.
- Phase 2 has started in a compatibility-preserving host-boundary form but is not complete.
- Phase 3 onward remains unimplemented.

What has landed:

- a new `src/extension-host/*` boundary now exists and owns active registry state
- the legacy plugin runtime now delegates active-registry ownership to the extension host
- registry activation now routes through `src/extension-host/activation.ts`
- initial normalized extension types now exist in code, including `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy`
- plugin manifest records now carry a normalized `resolvedExtension`
- a host-owned resolved-extension registry view now exists for static consumers
- an initial Phase 0 cutover inventory now exists in `src/extension-host/cutover-inventory.md`
- plugin SDK alias resolution now routes through `src/extension-host/loader-compat.ts`
- loader cache key construction and registry cache control now route through `src/extension-host/loader-cache.ts`
- loader provenance, duplicate-order, and warning policy now route through `src/extension-host/loader-policy.ts`
- loader initial candidate planning and record creation now route through `src/extension-host/loader-records.ts`
- loader entry-path opening and module import now route through `src/extension-host/loader-import.ts`
- loader module-export resolution, config validation, and memory-slot load decisions now route through `src/extension-host/loader-runtime.ts`
- loader post-import planning and `register(...)` execution now route through `src/extension-host/loader-register.ts`
- loader per-candidate orchestration now routes through `src/extension-host/loader-flow.ts`
- loader top-level load orchestration now routes through `src/extension-host/loader-orchestrator.ts`
- loader mutable activation state now routes through `src/extension-host/loader-session.ts`
- loader activation policy outcomes now route through `src/extension-host/loader-activation-policy.ts`
- loader record-state transitions now route through `src/extension-host/loader-state.ts`, which now enforces an explicit loader lifecycle state machine while preserving compatibility `PluginRecord.status` values
- loader finalization policy results now route through `src/extension-host/loader-finalization-policy.ts`
- loader final cache, readiness promotion, and activation finalization now routes through `src/extension-host/loader-finalize.ts`
- runtime registration normalization has started in `src/extension-host/runtime-registrations.ts` for channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook registrations
- several existing consumers now read host-owned normalized data instead of plugin-era manifest or runtime state directly:
  - channel and dock lookup surfaces
  - message-channel normalization
  - plugin HTTP route registry default lookup
  - package metadata parsing in discovery and install flows
  - channel catalog package metadata parsing
  - plugin skill discovery
  - plugin auto-enable
  - config doc baseline generation
  - config validation indexing

How it was done:

- by extracting a host-owned active-registry module first
- by turning `src/plugins/runtime.ts` into a compatibility facade rather than breaking existing callers
- by introducing normalized static schema types before changing heavy runtime activation paths
- by letting the legacy manifest registry project into a host-owned resolved-extension shape so existing call sites could migrate incrementally
- by migrating static consumers one by one onto resolved-extension data instead of forcing a single cutover
- by moving the first low-risk runtime writes behind host-owned helpers while keeping `src/plugins/registry.ts` as the compatibility call surface
- by leaving duplicate enforcement in legacy subsystems only where that behavior has not been migrated yet, such as plugin commands
- by moving the first loader-owned compatibility pieces behind host-owned helpers before changing discovery, enablement, or policy flow
- by moving cache-key construction, cache reads, cache writes, and cache clearing behind host-owned helpers before changing activation-state ownership
- by moving the next loader-owned policy helpers behind host-owned modules while preserving the current load/skip/error behavior
- by moving initial candidate planning and record construction behind host-owned helpers before changing import and registration flow
- by moving entry-path opening and module import behind host-owned helpers before changing cache wiring or lifecycle orchestration
- by moving loader runtime decisions next, while preserving lazy loading, config validation behavior, and memory-slot policy behavior
- by moving post-import planning and `register(...)` execution behind host-owned helpers before changing entry-path and import flow
- by composing those seams into one host-owned per-candidate orchestrator before changing cache and lifecycle finalization behavior
- by moving loader record-state transitions into host-owned helpers before enforcing them as a loader lifecycle state machine
- by moving cache writes, provenance warnings, final memory-slot warnings, and activation into a host-owned loader finalizer before introducing an explicit lifecycle state machine
- by adding explicit compatibility `lifecycleState` mapping on loader-owned plugin records before enforcing the loader lifecycle state machine
- by turning that compatibility `lifecycleState` field into an enforced loader lifecycle state machine with readiness promotion during finalization
- by moving the remaining top-level loader orchestration into a host-owned module so `src/plugins/loader.ts` becomes a compatibility facade instead of the real owner
- by moving mutable activation state such as seen-id tracking, memory-slot selection, and finalization inputs into a host-owned loader session instead of leaving them in top-level loader variables
- by moving duplicate precedence, config enablement, and early memory-slot gating into explicit host-owned activation-policy outcomes instead of leaving them inline in the loader flow
- by turning provenance-based untracked-extension warnings and final memory-slot warnings into explicit host-owned finalization-policy results before the finalizer applies them
- by moving static and lookup-heavy consumers first, where the ownership boundary matters but runtime risk is lower

Committed implementation slices so far:

- `6abf6750ee` `Plugins: add extension host registry boundary`
- `1aab89e820` `Plugins: extract loader host seams`
- `7bc3135082` `Plugins: extract loader candidate planning`
- `3a122c95fa` `Plugins: extract loader register flow`
- `fc81454038` `Plugins: extract loader import flow`
- `e1b207f4cf` `Plugins: extract loader candidate orchestration`
- `0c44d8049b` `Plugins: extract loader finalization`
- `33ef55a9ee` `Plugins: add loader lifecycle state mapping`
- `6590e19095` `Plugins: extract loader cache control`
- `c8d82a8f19` `Plugins: extract loader orchestration`
- `d32f65eb5e` `Plugins: add loader lifecycle state machine`
- `da9aad0c0f` `Plugins: add loader activation session`
- `fc51ce2867` `Plugins: add loader activation policy`
- `fd7488e10a` `Plugins: add loader finalization policy`
- `89414ed857` `Docs: track extension host migration internally`
- `d8af1eceaf` `Docs: refresh extension host migration status`

What has not landed:

- keeping the cutover inventory current as more surfaces move
- broader lifecycle ownership beyond the loader state machine, session-owned activation state, and explicit activation-policy and finalization-policy outcomes, plus remaining policy semantics
- host-owned registration surfaces beyond the first channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook helper slices
- SDK compatibility translation work
- canonical event stages
- canonical capability catalogs
- arbitration migration
- pilot migrations for `thread-ownership` or `telegram`

## Non-Negotiable End State

The kernel must not know about:

- plugins
- plugin manifests
- plugin ids
- plugin installation sources
- bundled versus external origin
- channel-specific runtime namespaces
- legacy `ChannelPlugin` compatibility shapes

The kernel may only know about:

- contributions
- capabilities
- adapters
- canonical events
- routing
- policy
- sessions
- agent-visible tools and actions

The distinction matters:

- "plugin" is a packaging and lifecycle concern
- "contribution" is a runtime contract

The extension host handles plugins. The kernel handles contributions.

## Executive Summary

Target architecture:

- `kernel`: pure runtime engine, no plugin-specific concepts
- `extension-host`: discovers extensions, resolves manifests, enforces enablement and conflicts, loads compatibility shims, and emits resolved contributions into the kernel
- `extensions`: all optional functionality, including bundled channels and bundled non-channel features

Key outcome:

- built-in and external extensions use the same contribution model
- the kernel sees only resolved runtime contributions
- agent-visible capabilities are compiled centrally from active contributions
- conflicting or overlapping providers are handled by explicit arbitration policies

How we fix it:

- lock the boundary first so no new plugin-shaped behavior spreads into the kernel
- add source-of-truth schema and minimal SDK compatibility before broad host migration
- move lifecycle, static metadata, and registry ownership into the extension host
- prove the model with `thread-ownership` first and `telegram` second
- replace fragmented event, catalog, and arbitration behavior with canonical systems
- remove the legacy runtime only after parity is proven and duplicate systems are gone

Security note:

- the first host cut is still operating inside OpenClaw's current trusted in-process extension model
- permission descriptors can gate activation, host-owned registries, and operator policy, but they are not a hard sandbox until a real isolation boundary exists

## Companion Specs

This plan is the architecture document. The concrete implementation contracts now live in companion specs:

- `openclaw-extension-contribution-schema-spec.md`
- `openclaw-extension-host-lifecycle-and-security-spec.md`
- `openclaw-kernel-event-pipeline-spec.md`
- `openclaw-capability-catalog-and-arbitration-spec.md`

Together, these close the remaining implementation gaps:

- exact contribution and manifest schema
- activation, dependency, permission, and persistence rules
- event-stage ordering, merge, veto, and resolver semantics
- capability naming, disambiguation, arbitration, and agent visibility rules

## Implementation Order

Implement in this order:

1. Phase 0: boundary inventory and anti-corruption layer
2. Phase 1: schema, package metadata, and minimal SDK compatibility
3. Phase 2: extension host lifecycle and registries
4. Phase 3: broader legacy compatibility bridges
5. Phase 4: canonical event pipeline
6. Phase 5: catalog migration
7. Phase 6: arbitration migration
8. Phase 7: broader migration and legacy removal

Why this order:

- schema and static metadata must exist before cheap-path install, onboarding, and status flows can move
- minimal SDK compatibility must exist before broader schema or host work can safely load current extensions
- host registries must exist before compatibility shims have somewhere correct to land
- event migration depends on the host and compatibility bridges
- catalogs and arbitration are migrations of existing behavior, not greenfield systems
- legacy removal is only safe after pilot parity and compatibility coverage are proven

## Design Principles

1. Plugin-agnostic kernel

The kernel must compile and function without any code that is semantically specific to plugins.

2. Contributions over registrations

The runtime contract is a graph of contributed capabilities, not a set of plugin-specific registration methods.

3. Bundled equals external

Bundled extensions must pass through the same host pipeline as external ones.

4. Capabilities are first-class

Agent-facing behavior is built from a canonical capability catalog, not from extension identities.

5. Conflicts are policy, not accidents

Name collisions, slot collisions, and overlapping providers must be resolved explicitly in the host.

6. Parallel providers are normal

Messaging, directory, and other capabilities may have multiple active providers at the same time.

7. Compatibility belongs outside the kernel

Legacy `ChannelPlugin` support and existing plugin API bridges must live in the extension host or shim packages, never in the kernel.

8. Security language must match the implementation

Permission descriptors are useful, but they must not be described as a security boundary while extensions still run as trusted in-process code.

9. Static descriptors stay separate from heavy runtime code

Install metadata, onboarding labels, docs links, and lightweight channel behavior must remain cheap to load and must not require activating a full adapter runtime.

10. Performance regressions are architectural bugs

The host must preserve current lazy-loading, caching, and lightweight shared-path behavior rather than rebuilding the same metadata on every startup path.

11. Replace existing behavior, do not duplicate it

Catalog, arbitration, setup, and status migration must absorb the existing partial systems rather than layering a second source of truth beside them.

## Architecture Overview

## 1. Kernel

The kernel is the runtime engine. It owns:

- canonical message and event types
- adapter runtime contracts
- routing
- session storage semantics
- policy evaluation
- capability catalog compilation
- ingress and egress pipelines
- agent tool visibility and arbitration
- telemetry over canonical events

The kernel does not load extensions directly.

## 2. Extension Host

The extension host owns:

- extension discovery
- bundled extension inventory
- external extension inventory
- manifest parsing
- distribution and install metadata
- lightweight adapter and channel descriptors for onboarding and status UX
- enablement and disablement state
- dependency and version checks
- conflict resolution
- provenance and trust-policy evaluation
- contribution graph assembly
- host-owned route, command, backend, credential, and state registries
- legacy compatibility wrappers
- SDK compatibility and deprecation shims
- error isolation during extension activation

The host converts extension packages into kernel contributions.

## 3. Extensions

Extensions contain actual optional functionality:

- channels
- provider auth helpers
- memory backends
- agent tools
- action handlers
- directory providers
- monitoring or lifecycle add-ons

Bundled extensions live in the distribution but are still optional. They are not special from the kernel’s perspective.

## Current Problems This Plan Solves

Today, OpenClaw already has a universal registry in `src/plugins/registry.ts:129`, but the runtime still mixes plugin-specific and channel-specific assumptions into core paths.

Examples:

- `src/channels/plugins/types.plugin.ts:49` defines a plugin-shaped runtime contract for channels
- `src/plugins/runtime/types-channel.ts:16` exposes a large channel-specific runtime namespace
- many channel monitors manually stitch together route resolution, session recording, context normalization, and reply dispatch, for example `extensions/matrix/src/matrix/monitor/handler.ts:646`

This creates four problems:

1. The runtime is not truly uniform.
2. New extensions need deep knowledge of internals.
3. Cross-cutting behavior is duplicated or inconsistently ordered.
4. The kernel is forced to retain channel- and plugin-shaped seams.

It also leaves important migration constraints that the new design must preserve:

- prompt-mutation policy controls such as `plugins.entries.<id>.hooks.allowPromptInjection`
- path-safety and provenance checks during discovery and load
- lazy startup behavior that avoids loading heavy runtimes on cheap code paths
- existing state layouts that cannot be discarded without migration

## Target Runtime Model

## 1. Contributions

A contribution is the only runtime unit the kernel accepts.

Suggested categories:

- `adapter.runtime`
- `capability.messaging`
- `capability.directory`
- `capability.memory`
- `capability.provider-integration`
- `capability.context-engine`
- `capability.agent-tool`
- `capability.interaction`
- `capability.status`
- `capability.setup`
- `capability.policy-augment`
- `capability.event-handler`
- `capability.runtime-backend`

The kernel consumes contributions through typed contracts.

## Current Runtime Surfaces That Must Be Cut Over

Before implementation starts, write and maintain a cutover inventory for every current plugin-owned surface:

- manifest loading and static metadata
- package-level install and onboarding metadata
- discovery, provenance, duplicate resolution, and origin precedence
- config schema and UI hint loading
- typed hooks and legacy hook bridges
- channels and channel lookup
- providers and provider auth or setup flows
- tools and agent-visible tool catalogs
- HTTP routes and gateway methods
- CLI registrars and plugin commands
- services and context-engine registrations
- slot selection and existing arbitration paths
- status, reload, install, update, and diagnostics surfaces

Each surface must be tagged as:

- kernel-owned
- host-owned
- compatibility-only

No new direct writes to global plugin registries should be added outside the new host boundary once Phase 0 begins.

## 1a. Extension taxonomy

The new model must support more than channels. "Extension" is the package or bundle unit. One extension may emit one or many contributions.

Representative extension classes in OpenClaw today:

- channel or transport extensions
- provider integration extensions
- agent-tool extensions
- memory extensions
- telephony or voice extensions
- background service extensions
- CLI or operator-surface extensions
- status, setup, or config extensions
- context augmentation extensions

Examples from the current repo:

- provider auth in `extensions/google-gemini-cli-auth/index.ts:24`
- agent tool plus route plus context augmentation in `extensions/diffs/index.ts:27`
- telephony, gateway methods, tools, CLI, and services in `extensions/voice-call/index.ts:230`
- memory tools, lifecycle handlers, CLI, and service in `extensions/memory-lancedb/index.ts:314`

The host must allow an extension to emit a mixed contribution set. Channels are only one case.

## 1b. Contribution families

The host should normalize extension outputs into a standard set of contribution families.

Kernel-facing runtime families:

- `adapter.runtime`
- `capability.agent-tool`
- `capability.control-command`
- `capability.provider-integration`
- `capability.memory`
- `capability.context-engine`
- `capability.context-augmenter`
- `capability.event-handler`
- `capability.route-augmenter`
- `capability.interaction`
- `capability.rpc`
- `capability.runtime-backend`

Host-managed families:

- `service.background`
- `surface.cli`
- `surface.config`
- `surface.status`
- `surface.setup`
- `surface.http-route`

This split is important:

- the kernel should own runtime behavior
- the host should own discovery, activation, admin surfaces, and compatibility

## 1c. Mapping from current APIs

Current extension APIs can be translated into contribution families by the extension host.

Suggested mapping:

- `registerChannel(...)` -> `adapter.runtime` plus lightweight dock metadata and optional `surface.config`, `surface.status`, `surface.setup`
- `registerProvider(...)` -> `capability.provider-integration` plus optional setup and auth surfaces
- `registerTool(...)` -> `capability.agent-tool`
- `registerCommand(...)` -> `capability.control-command`
- `on(...)` returning context or side effects -> `capability.context-augmenter` or `capability.event-handler`
- `on(...)` returning route, session-binding, or send-veto decisions -> `capability.route-augmenter`
- `registerGatewayMethod(...)` -> `capability.rpc`
- backend registration used by core subsystems -> `capability.runtime-backend`
- `registerContextEngine(...)` -> `capability.context-engine`
- `registerService(...)` -> `service.background`
- `registerCli(...)` -> `surface.cli`
- `registerHttpRoute(...)` -> `surface.http-route`
- config schema or UI hints -> `surface.config`
- package metadata used for install, onboarding, or channel catalogs -> host-owned static descriptors

Concrete examples:

- `extensions/google-gemini-cli-auth/index.ts:25` becomes `capability.provider-integration`
- `extensions/diffs/index.ts:27` becomes `capability.agent-tool`
- `extensions/diffs/index.ts:28` becomes a host-managed route or interaction surface
- `extensions/diffs/index.ts:38` becomes `capability.context-augmenter`
- `extensions/voice-call/index.ts:230` becomes `capability.rpc` and telephony runtime contributions
- `extensions/voice-call/index.ts:377` becomes `capability.agent-tool`
- `extensions/voice-call/index.ts:510` becomes `service.background`
- `extensions/acpx/src/service.ts:55` becomes `capability.runtime-backend`
- `extensions/memory-lancedb/index.ts:314` becomes `capability.agent-tool`
- `extensions/memory-lancedb/index.ts:548` becomes `capability.context-augmenter`
- `extensions/memory-lancedb/index.ts:664` becomes `service.background`
- `extensions/phone-control/index.ts:330` becomes `capability.control-command`
- `extensions/thread-ownership/index.ts:63` becomes `capability.route-augmenter`

## 1d. Lightweight descriptors and distribution metadata

The host also needs a static descriptor layer that is not the same thing as runtime contributions.

Current `main` still depends on package metadata and lightweight channel docks for:

- install and update eligibility
- onboarding and channel picker labels
- docs links and quickstart hints
- status and config surfaces that must stay cheap to load

Examples on `main`:

- package metadata in `src/plugins/manifest.ts:121`
- install validation in `src/plugins/install.ts:48`
- channel catalog assembly in `src/channels/plugins/catalog.ts:26`
- lightweight docks in `src/channels/dock.ts:228`

The revised plan should add host-owned static descriptors for:

- distribution and install metadata
- onboarding and channel catalog metadata
- lightweight adapter or channel dock metadata
- docs and quickstart hints
- config schema and UI hints used by host config APIs

These are consumed by the extension host and operator UX only.

They are not kernel contributions and they must not require loading a heavy adapter runtime.

Performance requirement:

- the host should preserve manifest caching, lazy runtime activation, and lightweight dock loading behavior comparable to `src/plugins/manifest-registry.ts:47`, `src/plugins/loader.ts:550`, and `src/channels/dock.ts:228`

Parity requirement:

- the static metadata model must preserve the host-visible channel fields used today in `src/plugins/manifest.ts:121` and `src/channels/plugins/catalog.ts:117`, including docs labels, aliases, precedence hints, binding hints, picker extras, and announce-target hints

## 1e. Event handler classes

The current plan needs a stronger distinction inside event-driven contributions. Not all handlers are equal.

The kernel should support these handler classes explicitly:

- `observer`
  Read-only. May emit telemetry or side effects, but cannot affect control flow.
- `augmenter`
  Adds context or metadata for later stages.
- `mutator`
  May transform payloads.
- `veto`
  May block an action such as send or route.
- `resolver`
  May authoritatively propose or override a routing or delivery decision.

This matters because current extensions already rely on these distinctions:

- `extensions/diffs/index.ts:38` is an augmenter
- `extensions/thread-ownership/index.ts:87` is a veto on send
- `extensions/discord/src/subagent-hooks.ts:103` is a delivery-target resolver

The plan must define:

- ordering rules
- merge rules
- veto precedence
- whether multiple resolvers compose or compete

Without this, the contribution model is too vague to safely replace today’s typed hook behavior.

The semantic taxonomy is useful, but the runner should stay close to how `main` actually executes hooks.

The first cut only needs three execution modes:

- parallel observers
- sequential merge or decision handlers
- sync sequential hot-path handlers for transcript persistence and message writes

Do not overbuild a more abstract scheduling system until the current hook classes have been migrated.

Implementation guardrail:

- keep the richer handler taxonomy as documentation of intent
- do not require separate engine machinery for every handler class in the first implementation

## 1f. Kernel event families need expansion

The current event list should be expanded beyond message and session events.

Additional families needed for parity with the repo:

- `gateway.started`
- `gateway.stopping`
- `agent.before-start`
- `agent.after-end`
- `agent.llm-input`
- `agent.llm-output`
- `tool.before-call`
- `tool.after-call`
- `transcript.tool-result-persisting`
- `transcript.message-writing`
- `compaction.before`
- `compaction.after`
- `session.resetting`
- `delivery.before-send`
- `delivery.after-send`
- `subagent.spawning`
- `subagent.delivery-target`
- `subagent.ended`
- `command.received`
- `command.completed`

These are required to cover:

- memory recall and auto-capture in `extensions/memory-lancedb/index.ts:548`
- send veto or mutation in `extensions/thread-ownership/index.ts:87`
- subagent thread binding in `extensions/discord/src/subagent-hooks.ts:41`
- transcript-write mutations in `src/plugins/hooks.ts:465`
- gateway, command, and agent event streams currently split across `src/hooks/internal-hooks.ts:13` and `src/infra/agent-events.ts:3`

## 1g. Metadata strategy

The plan must define how canonical events expose provider-specific metadata without pushing provider branches into the kernel.

Recommended rule:

- canonical fields for common semantics
- typed opaque metadata bag for provider-specific details
- metadata access helpers supplied by the contributing adapter or host layer
- lightweight static descriptors for operator-facing install and onboarding metadata

This is necessary because current extensions depend on provider-specific metadata such as:

- Slack thread and channel ids in `extensions/thread-ownership/index.ts:67`
- Discord thread-binding details in `extensions/discord/src/subagent-hooks.ts:67`

## 1h. Stateful and slot-backed runtime providers

The plan needs explicit categories both for extensions that provide runtime backends consumed by the rest of the system and for exclusive slot-backed providers selected by config.

ACP is the clearest example:

- `extensions/acpx/src/service.ts:55` registers a backend consumed elsewhere

Context engines are the clearest slot-backed example on `main`:

- slot definitions in `src/plugins/slots.ts:12`
- runtime resolution in `src/context-engine/registry.ts:60`

These are not ordinary services. They are subsystem providers. The kernel needs a typed way to consume them without knowing about plugins.

Suggested shape:

- `capability.runtime-backend`
  keyed by backend kind, for example `acp-runtime`, `memory-store`, `queue-owner`, or future execution backends
- `capability.context-engine`
  keyed by engine id, with explicit exclusive-slot selection and host-managed defaulting

Arbitration:

- usually `exclusive` or `ranked`
- context engines are explicitly `exclusive`
- memory needs both backend arbitration and agent-action arbitration

Migration requirement:

- preserve current slot defaults and config semantics during the transition, including `plugins.slots.memory` and `plugins.slots.contextEngine`

## 1i. HTTP and webhook surfaces

The current plan did not explicitly separate HTTP route ownership and webhook handling.

We need both:

- host-managed HTTP route contributions for extension-owned pages or APIs
- adapter-owned ingress endpoints for transport webhooks

Examples:

- `extensions/diffs/index.ts:28` exposes a plugin-owned route
- `extensions/voice-call/index.ts:230` depends on RPC-like gateway methods

The host must handle:

- path conflict detection
- auth policy at the route level
- route lifecycle tied to extension activation
- dynamic account-scoped route registration and teardown, not only startup-time static routes

This is required because `main` already supports runtime route registration and unregister handles in `src/plugins/http-registry.ts:12`.

## 1j. Operator commands versus agent tools

The plan must distinguish between:

- agent tools usable by the model
- operator or user commands that bypass the model
- CLI commands for local operators
- CLI onboarding and setup flows for local operators

Current examples:

- `extensions/llm-task/index.ts:5` is an agent tool
- `extensions/phone-control/index.ts:330` is a control command
- `extensions/memory-lancedb/index.ts:500` is CLI

These should not be collapsed into one generic concept.

Recommended split:

- `capability.control-command`
  chat or native commands that bypass the model on messaging surfaces
- `surface.cli`
  local operator CLI commands and subcommands
- `surface.setup`
  interactive or non-interactive onboarding and setup flows invoked by host-owned surfaces

This preserves the distinction that already exists on `main` between plugin CLI registrars, onboarding adapters, and chat control commands.

Parity rule:

- `capability.control-command` must preserve `acceptsArgs` matching behavior from `src/plugins/commands.ts:163`
- it must also preserve provider-specific native command names used by native command menus in `src/plugins/commands.ts:320`

## 1k. Provider integration and auth ownership

The plan needs to explicitly say where provider discovery, credential persistence, auth UX, and post-selection lifecycle hooks live.

Provider integration contributions need host-injected capabilities for:

- prompting
- browser or URL opening
- callback handling
- credential/profile persistence
- config patch application
- discovery order participation
- onboarding and wizard metadata
- token refresh or credential renewal
- model-selected lifecycle hooks

Example:

- `extensions/google-gemini-cli-auth/index.ts:25`
- provider plugin contracts in `src/plugins/types.ts:158`

The kernel should not own interactive auth UX or credential store write policy.

CLI implication:

- provider setup, onboarding, and auth flows may be extension-owned in behavior
- but they must execute through host-owned CLI and setup primitives
- the host remains responsible for prompting, credential persistence, config writes, and policy checks

## 1l. Permission model must match the trust model

Current `main` treats installed extensions as trusted in-process code:

- trusted plugin concept in `SECURITY.md:108`
- in-process loading in `src/plugins/loader.ts:621`

That means the first extension-host cut must not present permission grants as a hard security boundary.

In the initial host model:

- permissions gate activation, route exposure, host-managed registries, and operator audit
- permissions do not sandbox arbitrary Node imports, filesystem access, network access, or child processes
- operator UI and docs must describe this as trusted in-process mode

If OpenClaw later adds a real isolation boundary, keep the same descriptors but add an isolated execution mode where permissions become enforceable.

Implementation guardrail:

- phase 1 should implement `advisory` and `host-enforced`
- `sandbox-enforced` should remain a forward-compatible contract until a real isolation boundary exists

## 1m. Prompt mutation policy parity

The current runtime has a real policy knob for prompt mutation:

- `plugins.entries.<id>.hooks.allowPromptInjection` in `src/plugins/config-state.ts:14`
- enforcement in `src/plugins/registry.ts:547`

The new host and kernel split must preserve that behavior explicitly.

Do not collapse it into a generic permission list and lose the existing distinction between:

- prompt and model guidance that is allowed
- prompt mutation that is blocked or constrained by operator policy

Recommended treatment:

- keep prompt-mutation policy as a dedicated host-managed contribution policy
- apply it when translating legacy hooks and when compiling new event-handler or context-augmenter contributions

## 1n. SDK compatibility and deprecation plan

The migration also needs an explicit SDK story.

Current `main` still depends heavily on:

- compatibility alias loading in `src/plugin-sdk/root-alias.cjs`
- large runtime compatibility namespaces in `src/plugins/runtime/types-channel.ts:16`

Decision:

- introduce one new versioned extension-host SDK as the only target for new extension work
- treat existing `openclaw/plugin-sdk/*` subpaths as compatibility-only
- support at most one or two older SDK contract versions at a time through compatibility shims
- do not add new features to legacy subpaths; only bugfixes and migration bridges are allowed there

The transition plan should therefore include:

- a versioned extension-host SDK contract
- compatibility shims for current plugin SDK subpaths
- a deprecation timeline for channel-specific runtime namespaces
- contract tests that prove old extensions still load through the host during migration
- an explicit namespace-by-namespace migration map from `src/plugins/runtime/runtime-channel.ts:119` into the new SDK modules

Version rule:

- extensions declare `apiVersion`
- the host validates that version against the supported SDK compatibility window
- legacy compatibility windows should be short and explicit

## 1o. Resolved extension model

Decision:

- the extension host should use one `ResolvedExtension` object as the canonical internal data model
- that object must separate cheap static metadata from runtime-activated state

Suggested shape:

```ts
type ResolvedExtension = {
  id: string;
  version: string;
  apiVersion: string;
  source: {
    origin: "bundled" | "global" | "workspace" | "config";
    path: string;
    provenance?: string;
  };
  static: {
    install?: unknown;
    catalog?: unknown;
    docks?: unknown;
    docs?: unknown;
    setup?: unknown;
    config?: unknown;
  };
  runtime: {
    contributions: unknown[];
    services: unknown[];
    routes: unknown[];
    policies: unknown[];
    stateOwnership: unknown;
  };
};
```

Registries are then built from that object:

- static registry for install, onboarding, and lightweight UX paths
- runtime registry for activated contributions and services

This keeps lifecycle and provenance coherent while preserving cheap shared-path access.

The static section should also be able to carry host-consumed config schema and UI hints so config APIs can preserve redaction-aware schema behavior without activating runtime code.

Implementation guardrail:

- start with one `ResolvedExtension` model and two registries
- do not build extra registry layers unless a migration step proves they are needed

## 2. Capability descriptors

Every contribution must describe:

- stable contribution key
- capability kind
- public names and aliases
- scope
- exclusivity model
- precedence hints
- selection rules
- dependencies on other contributions
- agent visibility metadata

Example shape:

```ts
type ContributionDescriptor = {
  key: string;
  kind: string;
  names?: string[];
  aliases?: string[];
  scope?: "global" | "agent" | "session" | "channel" | "account";
  arbitration: "exclusive" | "ranked" | "parallel" | "composed";
  priority?: number;
  dependsOn?: string[];
  agentVisible?: boolean;
  description?: string;
  policy?: {
    promptMutation?: "none" | "append-only" | "replace-allowed";
    routeEffect?: "observe-only" | "augment" | "veto" | "resolve";
    failureMode?: "fail-open" | "fail-closed";
    executionMode?: "parallel" | "sequential" | "sync-sequential";
  };
};
```

Decision:

- these policy fields should be typed in the first foundation cut
- do not use an unstructured policy blob for the behaviors that affect safety and runtime semantics

## 3. Adapters

In this model, a channel is not a special plugin subtype. It is an adapter contribution plus related optional descriptors.

An adapter runtime contribution should include only transport behavior:

- normalize ingress events
- send and manage outbound messages
- optional fetch APIs
- optional interaction surfaces
- optional account lifecycle hooks

It may also expose typed behavioral descriptors for shared channel UX concerns such as:

- typing or presence behavior
- status reactions or delivery feedback
- thread defaults and reply context
- streaming and draft delivery behavior
- history or context hints needed by shared pipelines
- reload hints for config-driven hot restart or no-op handling
- gateway feature descriptors for method advertisement when needed during migration

It must not own routing, session semantics, pairing, or agent dispatch.

Clarification:

- adapter-level gateway descriptors are advertisement or compatibility metadata only
- callable gateway-style methods still map to `capability.rpc`
- this keeps `registerGatewayMethod(...)` on one migration path instead of splitting callable behavior across adapter and RPC surfaces

The host-side dock or adapter descriptor must still be rich enough to preserve current cheap-path behavior from `src/channels/dock.ts:56`, including:

- command gating hints
- allow-from formatting and default-target helpers
- threading defaults
- elevated fallbacks
- agent prompt hints such as `messageToolHints`

Implementation guardrail:

- preserve current cheap-path behavior
- do not design a broad adapter metadata platform beyond the fields needed for parity

## 4. Canonical events

Everything in the kernel flows through canonical events.

Suggested event families:

- `gateway.started`
- `gateway.stopping`
- `command.received`
- `command.completed`
- `ingress.received`
- `ingress.normalized`
- `routing.resolving`
- `routing.resolved`
- `session.starting`
- `session.started`
- `session.resetting`
- `agent.model.resolving`
- `agent.prompt.building`
- `agent.llm.input`
- `agent.llm.output`
- `agent.tool.calling`
- `agent.tool.called`
- `transcript.tool-result.persisting`
- `transcript.message.writing`
- `agent.completed`
- `egress.preparing`
- `egress.sent`
- `egress.failed`
- `interaction.received`
- `account.started`
- `account.stopped`
- `subagent.spawning`
- `subagent.delivery.resolving`
- `subagent.completed`

All cross-cutting logic should attach to these events.

Migration note:

- the current internal hook bus in `src/hooks/internal-hooks.ts:13`
- and the agent event stream in `src/infra/agent-events.ts:3`

must either be explicitly bridged into this event model or explicitly retired after parity is reached. Do not leave them as undocumented parallel systems.

## 5. Agent-visible capability catalog

Agents must not see plugins. They must see what they can do in the current context.

The kernel should compile a catalog from active contributions plus runtime context:

- current adapter
- current adapter action support
- current account
- current route
- current session
- policy
- permission checks
- arbitration outcome

Canonical action governance:

- canonical action ids remain open, namespaced strings such as `message.send` or `interaction.modal.open`
- the kernel should keep one source-of-truth registry for reviewed core action families
- if a new feature fits an existing semantic family, reuse that action id
- if the semantics are new, add a reviewed canonical action id to the core registry
- plugins must not invent new kernel-level arbitration semantics on their own

Examples of catalog entries:

- `message.send`
- `message.reply`
- `message.broadcast`
- `message.poll`
- `directory.lookup`
- `message.react`
- `message.edit`
- `message.delete`
- `message.pin`
- `memory.store`
- `memory.search`
- `interaction.modal.open`

The catalog may include provider hints only when needed for disambiguation.

Example:

- `message.send` with selectors `target`, `provider`, `account`
- `message.reply` without any provider selector if the route already determines it

## Conflict and Parallelism Model

This is a first-class requirement.

There are two separate conflict domains.

## 1. Host-level conflicts

These are resolved before contributions reach the kernel.

Examples:

- two extensions claim the same exclusive slot
- two extensions claim the same public command name
- two extensions claim the same contribution key

Host policy options:

- reject activation
- require explicit operator selection
- rank by configured priority
- rename or alias one contribution if allowed

## 2. Kernel-level capability arbitration

These are runtime selection questions, not activation errors.

Examples:

- multiple active messaging providers
- multiple directory providers
- multiple memory providers
- multiple prompt or policy augmenters

The kernel must support four arbitration modes.

### Exclusive

Only one provider may be active.

Use for:

- default session store backend
- default memory backend if multiple are not supported

### Ranked

Multiple providers may exist, but one becomes the default unless explicitly overridden.

Use for:

- tool implementations with sensible fallback ordering

### Parallel

Multiple providers are equally valid and may coexist simultaneously.

Use for:

- messaging channels
- directory providers
- channel-specific action providers

### Composed

Multiple providers contribute to a shared pipeline.

Use for:

- prompt augmentation
- event enrichment
- delivery observers

## Messaging is Parallel by Design

This is critical.

OpenClaw must support one agent receiving and sending through multiple channels and accounts simultaneously. Therefore:

- messaging cannot be modeled as an exclusive capability
- messaging providers must be scoped by adapter id and account id
- routing and target resolution determine which provider is used for a given action

Suggested provider identity:

- `messaging:slack:work`
- `messaging:telegram:default`
- `messaging:whatsapp:personal`

Selection order for outbound:

1. explicit target or explicit provider
2. current conversation route
3. session last-route
4. configured default binding
5. operator-defined fallback

Inbound selection is simpler:

- the ingress event arrives via one adapter provider
- routing resolves which agent and session receive it
- the reply path inherits that provider unless explicitly overridden

## Naming and Agent Visibility Rules

The host should separate human-facing extension names from kernel-facing capability names.

Extension metadata can say:

- package id
- extension id
- display name

But the kernel should compile normalized capability names:

- `message.send`
- `message.reply`
- `directory.lookup`
- `memory.search`

Conflicts in agent-visible names should be handled by the host and capability compiler.

Rules:

1. Prefer one canonical capability name for semantically equivalent actions.
2. Preserve provider identity as metadata, not as the primary tool name.
3. If two providers must both be visible, expose one canonical action with a provider selector instead of two arbitrarily named tools.
4. Only expose separate tools when the semantics are genuinely different.

Example:

Bad:

- `send_slack_message`
- `send_telegram_message`
- `send_discord_message`

Better:

- `message.send`
  with optional `provider` and `account`

Best in-context:

- `message.reply`
- `message.send`

Where route-derived provider selection means the agent usually does not need to name the concrete messaging provider explicitly.

## Proposed Module Layout

### Kernel

Suggested new top-level structure:

- `src/kernel/events/`
- `src/kernel/types/`
- `src/kernel/ingress/`
- `src/kernel/egress/`
- `src/kernel/routing/`
- `src/kernel/sessions/`
- `src/kernel/policy/`
- `src/kernel/catalog/`
- `src/kernel/runtime/`

### Extension Host

- `src/extension-host/discovery/`
- `src/extension-host/manifests/`
- `src/extension-host/enablement/`
- `src/extension-host/conflicts/`
- `src/extension-host/static/`
- `src/extension-host/install/`
- `src/extension-host/policy/`
- `src/extension-host/contributions/`
- `src/extension-host/compat/`
- `src/extension-host/activation/`

### Extensions

- `extensions/*`

The current plugin system should be gradually absorbed into `extension-host`, not `kernel`.

## Transition Strategy

This must be compatibility-first, but compatibility must live outside the kernel.

## Phase 0: Boundary Inventory And Anti-Corruption Layer

Objective:

Make the boundary explicit before implementation begins and prevent further spread of legacy plugin assumptions.

Tasks:

- write an ADR defining `kernel` versus `extension-host`
- define a rule that kernel code may not import from `src/plugins`, `src/plugin-sdk`, or `extensions/*`
- write the boundary cutover inventory for every current plugin-owned surface
- define which surfaces are kernel-owned, host-owned, or compatibility-only
- add anti-corruption interfaces so new work cannot write directly into global plugin registries
- document the trusted in-process security model so permission descriptors are not misrepresented
- define the compatibility and deprecation strategy for the existing plugin SDK surface
- add feature flags for host-path versus legacy-path execution where needed for staged rollout

Exit criteria:

- the boundary is explicit and testable
- every current plugin-owned surface is tagged with its target owner
- no new direct kernel dependencies on legacy plugin shapes are introduced

Current implementation status:

- partially implemented
- the anti-corruption boundary now exists in code through `src/extension-host/active-registry.ts`
- several central readers now go through that boundary
- the initial cutover inventory now exists in `src/extension-host/cutover-inventory.md` and is being updated as surfaces move, but the phase is still incomplete because loader orchestration, lifecycle ownership, and later compatibility phases have not moved yet

## Phase 1: Schema, Static Metadata, And Minimal SDK Compatibility

Objective:

Create the host data model and preserve extension loading while the boundary changes.

Tasks:

- define the `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy` types
- define canonical contribution descriptors, slot-backed provider types, and catalog-facing metadata types
- add source-of-truth manifest parsing for runtime contributions
- add package metadata parsing for install, onboarding, and lightweight operator UX
- define the new versioned SDK contract and supported compatibility window
- add minimal SDK compatibility loading so current `openclaw/plugin-sdk/*` imports still resolve while the host work lands
- define the static versus runtime sections of `ResolvedExtension`
- preserve config schema and UI hint parsing without activating heavy runtimes

Deliverables:

- source-of-truth schema types
- static metadata parser
- package metadata parser
- compatibility-loading surface for the current SDK imports

Exit criteria:

- extensions can be normalized into static and runtime sections without activating heavy runtime code
- existing extensions still load through the compatibility loading path

Current implementation status:

- partially implemented
- a normalized static model exists in code through `ResolvedExtension`
- package metadata and manifest metadata now converge into host-owned normalized records
- discovery and install metadata parsing now go through host schema helpers
- partial explicit compatibility now exists through host-owned loader-compat and loader-runtime helpers, but a versioned minimal SDK compatibility layer still does not exist

## Phase 2: Extension Host Lifecycle And Registries

Objective:

Move lifecycle and ownership concerns into the host.

Tasks:

- create extension discovery and manifest loaders
- move enablement logic into host
- move bundled extension inventory into host
- move install and onboarding metadata into host-owned static descriptors
- move contribution assembly into host
- move provenance, origin precedence, and slot policy into host
- implement contribution graph validation
- implement host-owned registries for hooks, channels, providers, tools, HTTP routes, gateway methods, CLI, services, commands, config, setup, status, backends, and slot-backed providers
- implement per-extension state and route registries
- preserve path-safety, provenance, duplicate-origin hardening, startup laziness, and manifest caching behavior
- keep current built-in onboarding fallbacks in place during early migration
- preserve current setup adapter phases such as status, configure, reconfigure, disable, and DM policy handling

Deliverables:

- `src/extension-host/*`
- host-owned static registry
- host-owned runtime registry

Exit criteria:

- the host can discover bundled and external extensions, preserve static metadata, and populate normalized registries
- registries are populated through host-owned interfaces rather than direct legacy global writes

Current implementation status:

- partially implemented in a compatibility-preserving form
- the host now owns active registry state
- the host now exposes resolved static registries for static consumers
- activation, loader cache control, loader policy, loader activation-policy outcomes, loader finalization-policy outcomes, loader runtime decisions, loader top-level load orchestration, loader session state, loader record-state helpers, and loader finalization now route through `src/extension-host/*`
- broader lifecycle ownership beyond the loader state machine, registration surfaces, policy gates, and activation-state management are still pending

## Phase 3: Broader Legacy Compatibility Bridges

Objective:

Keep current extensions working through the host without leaking legacy contracts into the kernel.

Tasks:

- implement `ChannelPlugin` compatibility shims in `src/extension-host/compat/`
- adapt current plugin registrations into contribution descriptors
- translate current config schema and UI hint registration into `surface.config`
- translate existing plugin CLI registrars and onboarding adapters into `surface.cli` and `surface.setup`
- adapt existing gateway and status surfaces into host-level descriptors
- adapt current package metadata and channel docks into host-owned static descriptors
- preserve prompt-mutation policy enforcement when translating legacy hooks
- preserve config redaction semantics driven by `config.uiHints.sensitive`
- preserve hot reload, no-op config prefix behavior, and gateway feature advertisement where those behaviors still exist
- add compatibility translation for current runtime-channel helper namespaces into the new SDK modules
- maintain a parity matrix for each pilot migration

Important rule:

No legacy `ChannelPlugin` type or shim code may appear under `src/kernel/`.

Exit criteria:

- `thread-ownership` runs through the host path as the first non-channel pilot
- `telegram` runs through the host path as the first channel pilot
- both pilots have explicit parity results for discovery, config, activation, diagnostics, and runtime behavior

## Phase 4: Canonical Event Pipeline

Objective:

Move runtime behavior onto explicit canonical events and stage rules.

Tasks:

- define canonical event and stage types
- define sync transcript-write stages explicitly
- bridge current plugin hooks, internal hooks, and agent event streams into canonical stages in the extension host only
- map legacy typed hooks into canonical stage semantics
- keep permission descriptors host-owned and policy-oriented until real isolation exists
- move compatibility facades into extension-host shims rather than adding new kernel leakage

Exit criteria:

- pilot extensions use canonical event stages with parity to current behavior
- any remaining legacy event buses are explicitly documented as compatibility-only

## Phase 5: Catalog Migration

Objective:

Replace plugin-identity-driven catalog behavior with canonical family-based catalogs.

Tasks:

- compile active contributions into kernel internal and kernel agent catalogs
- publish host-owned operator and static setup catalogs
- migrate existing tool, provider, setup, and onboarding catalog surfaces onto canonical or host-owned catalog paths
- resolve naming conflicts
- collapse equivalent provider-specific actions into canonical agent tools where appropriate
- add explicit provider selection only when needed
- preserve dedicated prompt-mutation policy filtering during catalog compilation where relevant

Implementation guardrail:

- start with one kernel internal catalog, one kernel agent catalog, and host-owned operator or static registries
- do not build a larger publication framework until the registries are stable

Exit criteria:

- agent-visible tool inventory is generated from contribution metadata and kernel context
- setup and install catalogs no longer depend on duplicated legacy metadata paths

## Phase 6: Arbitration Migration

Objective:

Absorb the existing conflict-resolution behavior into explicit arbitration.

Tasks:

- implement host-level activation conflict resolution
- implement kernel-level runtime provider selection
- migrate existing slot selection and provider selection logic onto canonical arbitration
- add explicit selection APIs for provider-scoped actions
- ensure session route and last-route semantics interact correctly with parallel messaging providers
- cover messaging parallelism, directory overlap, memory backend exclusivity, context-engine slot exclusivity, composed prompt or policy augmenters, and dynamic route conflicts

Exit criteria:

- at least one multi-provider family works through canonical arbitration
- legacy slot and provider-selection paths no longer operate as separate arbitration systems

## Phase 7: Broader Migration And Legacy Removal

Objective:

Finish the cutover and remove compatibility-only surfaces in a controlled order.

Tasks:

- migrate remaining channels and non-channel extensions in batches
- remove legacy plugin registry entry points once no longer needed
- deprecate `runtime.channel`
- deprecate per-channel SDK subpaths where a neutral replacement exists
- retain only thin compatibility packages until extension migration is complete
- remove the built-in onboarding fallback only after host-owned setup surfaces reach parity for bundled channels

Suggested second-wave compatibility candidates after the initial pilots:

- `line` for channel plus command registration
- `device-pair` for command, service, and setup-flow coverage

Exit criteria:

- built-in channels behave like ordinary extensions through the host
- the legacy plugin runtime is no longer the default execution path
- kernel no longer imports old plugin infrastructure

## Pilot Matrix

Initial pilots:

- non-channel pilot: `thread-ownership`
- channel pilot: `telegram`

Why this order:

- `thread-ownership` exercises typed hook behavior with limited surface area
- `telegram` exercises the `ChannelPlugin` compatibility path with a minimal top-level registration surface

Each pilot must record parity for:

- discovery and precedence
- manifest and static metadata loading
- config schema and UI hints
- enabled and disabled state handling
- activation and reload behavior
- diagnostics and status output
- runtime behavior on the migrated path
- compatibility-only gaps that still remain

## Concrete Refactoring Targets

The following current areas should be moved or replaced.

### Move out of kernel

- plugin registry logic now in `src/plugins/registry.ts:129`
- plugin loader logic now in `src/plugins/loader.ts:37`
- plugin runtime channel namespace in `src/plugins/runtime/types-channel.ts:16`
- direct plugin-specific API types in `src/plugins/types.ts:263`

### Replace with neutral kernel services

- route resolution entrypoints currently in `src/routing/resolve-route.ts:614`
- outbound pipeline seed in `src/infra/outbound/deliver.ts:141`
- session recording flow currently called by many channels
- canonical hook or event dispatch ordering
- transcript persistence and message-write stages currently embedded in `src/plugins/hooks.ts:465`

### Keep only in host compatibility

- `ChannelPlugin` contract in `src/channels/plugins/types.plugin.ts:49`
- plugin SDK subpath facades like `src/plugin-sdk/telegram.ts:1`

## Verification Strategy

## Boundary tests

- kernel has no imports from `src/plugins`, `src/plugin-sdk`, or `extensions/*`
- host may import kernel, but kernel may not import host

## Contract tests

- contribution contract tests
- arbitration contract tests
- capability catalog tests
- adapter runtime contract tests

## Behavior parity tests

- route resolution parity
- session transcript parity
- message hook or event ordering parity
- outbound payload parity
- multi-account parity
- install and onboarding catalog parity
- context-engine slot parity
- sync transcript-write parity
- prompt-mutation policy parity
- path-safety and provenance parity
- startup-cost parity for lightweight UX paths

## Parallel provider tests

- one agent active on Slack and Telegram simultaneously
- reply follows inbound route by default
- explicit cross-channel send works
- session last-route does not break when multiple messaging providers are active

## Conflict tests

- duplicate contribution key
- duplicate exclusive slot
- duplicate agent-visible tool alias
- two ranked providers with clear default resolution

## Operational Plan

1. Introduce kernel and host boundaries first.
2. Add import guards and the boundary cutover inventory so the boundary cannot regress.
3. Add source-of-truth schema types, static metadata parsing, and minimal SDK compatibility loading.
4. Move plugin lifecycle and registry ownership into the host without behavior changes.
5. Add compatibility shims in the host and record pilot parity as each surface moves.
6. Migrate `thread-ownership` through the host path first.
7. Migrate `telegram` through the host path second.
8. Add canonical event routing for the pilot surfaces.
9. Migrate existing catalog and arbitration paths rather than adding parallel ones.
10. Migrate remaining extensions in batches.
11. Start deprecating old plugin-facing runtime surfaces.

## Risks

Risk:

The contribution model becomes too abstract and hard to use.

Mitigation:

Provide good host-side helpers and templates. Keep kernel contracts narrow and transport-focused.

Risk:

Agent-visible catalog becomes confusing when many providers are active.

Mitigation:

Use canonical actions first, provider selectors second, provider-specific names only as a last resort.

Risk:

Parallel messaging providers create routing ambiguity.

Mitigation:

Define and test explicit outbound selection order. Route and session metadata must always carry adapter and account identity.

Risk:

Compatibility shims silently leak old plugin assumptions back into the kernel.

Mitigation:

Enforce import boundaries with CI and keep all legacy code under the host only.

Risk:

The cutover inventory misses one of the current plugin-owned surfaces, so behavior quietly stays on the legacy path.

Mitigation:

Treat the boundary cutover inventory as a tracked artifact, update it before changing ownership, and require each pilot to mark which surfaces are full parity, partial parity, or still compatibility-only.

Risk:

Bundled extensions are treated as privileged again over time.

Mitigation:

Run bundled extensions through the same host activation and contribution pipeline as external extensions.

Risk:

Permission descriptors overpromise security that the runtime does not yet provide.

Mitigation:

Keep permission language explicitly policy-oriented until OpenClaw ships a real isolation boundary.

Risk:

The migration drops current onboarding, install, or lightweight dock behavior while focusing only on runtime contributions.

Mitigation:

Treat static host descriptors as a first-class part of the migration, with parity tests for channel catalogs and onboarding flows.

Risk:

The host adds enough abstraction to regress startup cost or force heavy adapter loads on shared code paths.

Mitigation:

Make lazy activation, manifest caching, and lightweight dock descriptors explicit success criteria and test them.

Risk:

The migration breaks existing extensions because the SDK compatibility story is under-specified.

Mitigation:

Ship a versioned SDK contract, compatibility shims, and an explicit deprecation timeline before removing old subpaths.

Risk:

Catalog and arbitration migration leaves legacy tool, provider, or slot-selection systems running in parallel with the new model.

Mitigation:

Treat Phase 5 and Phase 6 as replacement work. Track the current tool catalog, provider-selection, and slot-selection paths explicitly and do not declare those phases complete until the duplicate systems are removed or downgraded to documented compatibility-only shims.

## Suggested First PRs

PR 1:

Add `kernel` and `extension-host` directory structure, boundary ADR, import guards, and the boundary cutover inventory.

PR 2:

Define `ResolvedExtension`, `ResolvedContribution`, static metadata types, and the minimal SDK compatibility-loading surface.

PR 3:

Move existing plugin discovery, manifest parsing, provenance handling, and registry ownership into `extension-host` while preserving behavior.

PR 4:

Add host-side compatibility shim for current hook, provider, and `ChannelPlugin` surfaces.

PR 5:

Migrate `thread-ownership` through the new host-to-kernel path with explicit parity tracking.

PR 6:

Migrate `telegram` through the new host-to-kernel path with explicit parity tracking.

## Success Criteria

This transition succeeds when all of the following are true:

- the kernel contains no plugin-specific concepts
- bundled and external extensions activate through the same host pipeline
- agent-visible capabilities are compiled centrally from active contributions
- duplicate or overlapping providers are resolved through explicit arbitration
- one agent can receive and send across multiple active messaging providers cleanly
- install, onboarding, and lightweight dock metadata still work through host-owned static descriptors
- context-engine and memory slot behavior are preserved through explicit slot-backed contributions
- transcript-write hooks are preserved through explicit canonical stages
- prompt-mutation policy behavior is preserved through explicit host policy
- startup-time lightweight paths do not force heavy runtime activation
- existing extensions have a documented compatibility and deprecation path through the host SDK
- legacy compatibility exists only in the extension host and can be deleted later without changing kernel semantics

## Final Recommendation

Adopt the stricter model.

Do not let the universal adapter effort stop at “better plugin architecture.” The correct end state is a plugin-agnostic kernel with an extension host layered on top. That is the cleanest way to support optional bundled extensions, clean agent capability surfacing, deterministic conflict handling, and true parallel providers for messaging and other runtime capabilities.
