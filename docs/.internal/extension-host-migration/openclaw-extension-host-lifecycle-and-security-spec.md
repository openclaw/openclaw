Temporary internal migration note: remove this document once the extension-host migration is complete.

# OpenClaw Extension Host Lifecycle And Security Spec

Date: 2026-03-15

## Purpose

This document defines how the extension host discovers, validates, activates, isolates, and stops extensions while applying operator policy, permission metadata, persistence boundaries, and contribution dependencies.

The kernel does not participate in these concerns directly.

## TODOs

- [x] Write the initial boundary cutover inventory for every current plugin-owned surface.
- [ ] Keep the boundary cutover inventory updated as surfaces move.
- [ ] Extend the loader lifecycle state machine into full extension-host lifecycle ownership and document the concrete runtime states in code.
- [ ] Implement advisory versus enforced permission handling exactly as specified here.
- [ ] Implement host-owned registries for config, setup, CLI, routes, services, slots, and backends.
- [ ] Implement per-extension state ownership and migration from current shared plugin state.
- [ ] Record pilot parity for `thread-ownership` first and `telegram` second before broad legacy rollout.
- [ ] Track which hardening, reload, and provenance rules have reached parity with `main`.

## Implementation Status

Current status against this spec:

- registry ownership and the first compatibility-preserving loader slices have landed
- a loader-scoped lifecycle state machine has landed
- broader lifecycle orchestration, policy gates, and activation-state management have not landed

What has been implemented:

- an initial Phase 0 cutover inventory now exists in `src/extension-host/cutover-inventory.md`
- active registry ownership now lives in the extension host boundary rather than only in plugin-era runtime state
- central lookup surfaces now consume the host-owned active registry
- registry activation now routes through `src/extension-host/activation.ts`
- a host-owned resolved-extension registry exists for static consumers
- static config-baseline generation now reads bundled extension metadata through the host-owned resolved-extension registry
- channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook registration normalization now delegates through `src/extension-host/runtime-registrations.ts`
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

How it has been implemented:

- by extracting `src/extension-host/active-registry.ts` and making `src/plugins/runtime.ts` delegate to it
- by leaving lifecycle behavior unchanged for now and only moving ownership of the shared registry boundary
- by moving low-risk readers first, such as channel lookup, dock lookup, message-channel lookup, and default HTTP route registry access
- by extending that same host-owned boundary into static consumers instead of introducing separate one-off metadata loaders
- by starting runtime-registry migration with low-risk validation and normalization helpers while leaving lifecycle ordering and activation behavior unchanged
- by leaving start/stop ordering and duplicate-enforcement behavior in legacy subsystems where those subsystems are still the real owner
- by treating hook execution and hook registration as separate migration concerns so event-pipeline work does not get conflated with record normalization
- by starting loader/lifecycle migration with activation and SDK alias compatibility helpers while leaving discovery and policy flow unchanged
- by moving cache-key construction, cache reads, cache writes, and cache clearing next while leaving activation-state ownership unchanged
- by moving provenance and duplicate-order policy next, so lifecycle migration can land on host-owned policy helpers instead of loader-local utilities
- by moving initial candidate planning and record construction next while leaving module import and registration flow unchanged
- by moving entry-path opening and module import next while leaving cache wiring and lifecycle orchestration unchanged
- by moving loader runtime decisions next while preserving the current lazy-load, config-validation, and memory-slot behavior
- by moving post-import planning and `register(...)` execution next while leaving entry-path and import flow unchanged
- by composing those seams into one host-owned per-candidate loader orchestrator before moving final lifecycle-state behavior
- by moving the remaining top-level loader orchestration into a host-owned module before enforcing the loader lifecycle state machine
- by moving record-state transitions first into a compatibility layer and then into an enforced loader lifecycle state machine
- by moving cache writes, provenance warnings, final memory-slot warnings, and activation into a host-owned loader finalizer before introducing an explicit lifecycle state machine
- by adding explicit compatibility `lifecycleState` mapping on loader-owned plugin records before enforcing the loader lifecycle state machine
- by promoting successfully registered plugins to `ready` during host-owned finalization while leaving broader activation-state semantics for later phases
- by moving mutable activation state such as seen-id tracking, memory-slot selection, and finalization inputs into a host-owned loader session before broader activation-state semantics move
- by moving duplicate precedence, config enablement, and early memory-slot gating into explicit host-owned activation-policy outcomes before broader policy semantics move
- by turning provenance-based untracked-extension warnings and final memory-slot warnings into explicit host-owned finalization-policy results before the finalizer applies them

What is still pending from this spec:

- broader extension-host lifecycle ownership beyond the loader state machine, session-owned activation state, and explicit activation-policy and finalization-policy outcomes
- activation pipeline ownership
- host-owned registries for setup, CLI, routes, services, slots, and backends
- permission-mode enforcement
- per-extension state ownership and migration
- provenance, reload, and hardening parity tracking

## Goals

- deterministic activation and shutdown
- explicit failure states
- no hidden privilege escalation
- stable persistence ownership rules
- truthful security semantics for the current trusted in-process model
- safe support for bundled and external extensions under the same model
- preserve existing hardening and prompt-mutation policy behavior during the migration

## Implementation Sequencing Constraints

This spec is not a greenfield host design.

The host must absorb existing behavior that already lives in:

- plugin discovery and manifest loading
- config schema and UI hint handling
- route and gateway registration
- channels and channel lookup
- providers and provider auth or setup flows
- tools, commands, and CLI registration
- services, backends, and slot-backed providers
- reload, diagnostics, install, update, and status behavior

Therefore:

- Phase 0 must produce a cutover inventory for those surfaces before registry ownership changes begin
- Phase 1 must preserve current SDK loading through minimal compatibility support
- Phase 2 registry work must be broad enough to cover all currently registered surfaces, not only a narrow runtime subset
- Phase 3 must prove parity through `thread-ownership` first and `telegram` second before broader rollout

## Trust Model Reality

Current `main` treats installed and enabled extensions as trusted code running in-process:

- trusted plugin concept in `SECURITY.md:108`
- in-process loading in `src/plugins/loader.ts:621`

That means the initial extension host has two separate jobs:

- enforce operator policy for activation, route exposure, host-owned registries, and auditing
- accurately communicate that this is not yet a hard sandbox against arbitrary extension code

Recommended enforcement levels:

- `advisory`
  Host policy, audit, and compatibility guidance only. This is the current default. Permission mismatch alone should not block activation in this mode, though the host may warn and withhold optional host-published surfaces.
- `host-enforced`
  Host-owned capabilities and registries are gated, but extension code still runs in-process.
- `sandbox-enforced`
  A future mode with real process, VM, or IPC isolation where permissions become a true security boundary.

## Lifecycle States

Every extension instance moves through these states:

1. `discovered`
2. `manifest-loaded`
3. `validated`
4. `dependency-resolved`
5. `policy-approved`
6. `instantiated`
7. `registered`
8. `starting`
9. `ready`
10. `degraded`
11. `stopping`
12. `stopped`
13. `failed`

The host owns the state machine.

## Activation Pipeline

### 1. Discovery

The host scans:

- bundled extension inventory
- configured external extension paths or packages
- disabled extension state

Discovery is metadata-only. No extension code executes in this phase.

### 2. Manifest Load

The host loads and validates manifest syntax.

Failures here prevent instantiation.

This phase must cover both:

- runtime contribution descriptors
- package-level static metadata used for install, onboarding, status, and lightweight operator UX

### 3. Schema Validation

The host validates:

- top-level extension manifest
- contribution descriptors
- config schema
- config UI hints and sensitivity metadata
- permission declarations
- dependency declarations
- policy declarations such as prompt-mutation behavior

### 4. Dependency Resolution

The host resolves:

- extension api compatibility
- SDK compatibility mode and deprecation requirements
- required contribution dependencies
- optional dependencies
- conflict declarations
- singleton slot collisions

Compatibility decision:

- the host should support only a short compatibility window, ideally one or two older SDK contract versions at a time
- extensions outside that window must fail validation with a clear remediation path

Sequencing rule:

- minimal compatibility loading must exist before broader schema or registry changes depend on the new manifest model

### 5. Policy Gate

The host computes the requested permission set and compares it against operator policy.

In `host-enforced` or `sandbox-enforced` mode, extensions that are not allowed to receive all required permissions do not activate or do not register the gated contributions.

In `advisory` mode, this gate records warnings, informs operator-visible policy state, and may withhold optional host-published surfaces, but permission mismatch alone does not fail activation.

It does not sandbox arbitrary filesystem, network, or child-process access from trusted in-process extension code.

### 6. Instantiation

The host loads the extension entrypoint and asks it to emit contribution descriptors and runtime factories.

Unless the host is running in a future isolated mode, instantiation still executes trusted extension code inside the OpenClaw process.

### 7. Registration

The host resolves runtime ids, arbitration metadata, and activation order, then registers contributions into host-owned registries.

This includes host-managed operator registries for:

- CLI commands
- setup and onboarding flows
- config and status surfaces
- dynamic HTTP routes
- config reload descriptors and gateway feature advertisement where those surfaces remain host-managed during migration

Callable gateway or runtime methods are separate from this advertisement layer and should continue to register through the runtime contribution model as `capability.rpc`.

The registration boundary should cover the full current surface area as one migration set:

- hooks and event handlers
- channels and lightweight channel descriptors
- providers and provider-setup surfaces
- tools and control commands
- CLI, setup, config, and status surfaces
- HTTP routes and gateway methods
- services, runtime backends, and slot-backed providers

Do not migrate only a subset and leave the rest writing into the legacy registry model indefinitely.

### 8. Start

The host starts host-managed services, assigns per-extension state and route ownership, and activates kernel-facing contributions.

### 9. Ready

The extension is active and visible to kernel or operator surfaces as appropriate.

## Failure Modes

Supported failure classes:

- `manifest-invalid`
- `api-version-unsupported`
- `dependency-missing`
- `dependency-conflict`
- `policy-denied`
- `instantiation-failed`
- `registration-conflict`
- `startup-failed`
- `runtime-degraded`

The host must record failure class, extension id, contribution ids, and operator-visible remediation.

## Dependency Rules

Dependencies must be explicit and machine-checkable.

### Extension-level dependencies

Used when one extension package requires another package to be present.

### Contribution-level dependencies

Used when a specific runtime contract depends on another contribution.

Examples:

- a route augmenter may require a specific adapter family
- an auth helper may require a provider contribution
- a diagnostics extension may optionally bind to a runtime backend if present

### Conflict rules

Extensions may declare:

- `conflicts`
- `supersedes`
- `replaces`

The host resolves these before activation.

## Discovery And Load Hardening

The extension host must preserve current path-safety, provenance, and duplicate-resolution protections.

At minimum, preserve parity with:

- path and boundary checks during load in `src/plugins/loader.ts:744`
- manifest precedence and duplicate-origin handling in `src/plugins/manifest-registry.ts:15`
- provenance warnings during activation in `src/plugins/loader.ts:500`

Security hardening from the current loader is part of the host contract, not an optional implementation detail.

Parity requirement:

- the pilot migrations must show that these hardening rules still apply on the host path, not only on the legacy path

## Policy And Permission Model

Permissions are granted to extension instances by the host as policy metadata and host capability grants.

The kernel must never infer privilege from contribution kind alone.

The host must track both:

- requested permissions
- enforcement level (`advisory`, `host-enforced`, or `sandbox-enforced`)
- host-managed policy gates such as prompt mutation and sync hot-path eligibility

### Recommended permission set

- `runtime.adapter`
- `runtime.route-augment`
- `runtime.veto-send`
- `runtime.backend-register`
- `agent.tool.expose`
- `control.command.expose`
- `interaction.handle`
- `rpc.expose`
- `service.background`
- `http.route.gateway`
- `http.route.plugin`
- `config.read`
- `config.write`
- `state.read`
- `state.write`
- `credentials.read`
- `credentials.write`
- `network.outbound`
- `process.spawn`
- `filesystem.workspace.read`
- `filesystem.workspace.write`

Permissions should be independently reviewable and denyable.

In `advisory` mode they also function as:

- operator review prompts
- activation policy inputs
- audit and telemetry tags
- documentation of why an extension needs sensitive host-owned surfaces

### Fine-grained policy gates

Some behavior should remain under dedicated policy gates instead of being flattened into generic permissions.

Examples:

- prompt mutation or prompt injection behavior
- sync transcript-write participation
- fail-open versus fail-closed route augmentation

This preserves the intent of current controls such as `plugins.entries.<id>.hooks.allowPromptInjection`.

### High-risk permissions

These should require explicit operator approval or a strong default policy:

- `runtime.veto-send`
- `runtime.route-augment`
- `runtime.backend-register`
- `credentials.write`
- `process.spawn`
- `http.route.plugin`
- `filesystem.workspace.write`

High-risk permissions should still matter in `advisory` mode because they drive operator trust decisions even before real isolation exists.

## Persistence Ownership

Persistence must be partitioned by owner and intent.

### Config

Operator-managed configuration belongs to the host.

Extensions may contribute:

- config schema
- config UI hints and sensitivity metadata
- defaults
- migration hints
- setup flow outputs such as config patches produced through host-owned setup primitives

Extensions must not arbitrarily mutate unrelated config keys.

The host must also preserve current config redaction semantics:

- config UI hints such as `sensitive` affect host behavior, not only UI decoration
- config read, redact, restore, and validate flows must preserve round-trippable secret handling comparable to `src/gateway/server-methods/config.ts:151` and `src/config/redact-snapshot.ts:349`

### State

Each extension gets a host-assigned state directory.

This is where background services and caches persist local state.

This is a required migration change from the current shared plugin service state shape in `src/plugins/services.ts:18`.

The host must also define a migration strategy for existing state:

- detect old shared plugin state layouts
- migrate or alias data into per-extension directories
- keep rollback behavior explicit

### Credentials

Credential persistence is host-owned.

Provider integration extensions may return credential payloads, but they must not choose final storage shape or bypass the credential store.

This is required because auth flows like `extensions/google-gemini-cli-auth/index.ts:24` interact with credentials and config together.

This rule also applies when those flows are invoked through extension-owned CLI or setup flows.

### Session and transcript state

Kernel-owned.

Extensions may observe or augment session state through declared runtime contracts, but they do not own transcript persistence.

### Backend-owned state

Runtime backends such as ACP may require separate service state, but ownership still flows through the host-assigned state boundary.

### Distribution and onboarding metadata

Install metadata, channel catalog metadata, docs links, and quickstart hints are host-owned static metadata.

They are not kernel persistence and they are not extension-private state.

That static metadata should preserve current channel catalog fields from `src/plugins/manifest.ts:121`, including aliases, docs labels, precedence hints, binding hints, picker extras, and announce-target hints.

## HTTP And Webhook Ownership

The host owns all HTTP route registration and conflict resolution.

This is required because routes can conflict across extensions today, as seen in `src/plugins/http-registry.ts:12`.

### Route classes

- ingress transport routes
- authenticated plugin routes
- public callback routes
- diagnostic or admin routes
- dynamic account-scoped routes

### Required route metadata

- path
- auth mode
- match mode
- owner contribution id
- whether the route is externally reachable
- whether the route is safe to expose when the extension is disabled
- lifecycle mode (`static` or `dynamic`)
- scope metadata such as account, workspace, or provider binding

### Conflict rules

- exact path collisions require explicit resolution
- prefix collisions require overlap analysis
- auth mismatches are fatal
- one extension may not replace another extension's route without explicit policy

Dynamic route registration must also return an unregister handle so route ownership can be cleaned up during reload, account removal, or degraded shutdown.

## Runtime Backend Contract

Some extension contributions provide runtime backends consumed by subsystems rather than directly by the agent.

ACP is the reference case today:

- backend type in `src/acp/runtime/registry.ts:4`
- registration in `extensions/acpx/src/service.ts:55`

### Required backend descriptor

- backend class id
- backend instance id
- selector key
- health probe
- capability list
- selection rank
- arbitration mode

### Required backend lifecycle

- register
- unregister
- probe
- health
- degrade
- recover

### Backend selection rules

- explicit requested backend id wins
- if none requested, pick the healthiest backend with the best rank
- if multiple healthy backends tie, use deterministic ordering by extension id then contribution id
- if all backends are unhealthy, expose a typed unavailability error

### Singleton vs parallel

Not every backend is singleton.

ACP may remain effectively singleton at first, but the contract should support future parallel backends with explicit selectors.

## Slot-Backed Provider Contract

Not every exclusive runtime provider is a generic backend.

Current `main` already has slot-backed provider selection in:

- `src/plugins/slots.ts:12`
- `src/context-engine/registry.ts:60`

The host must model explicit slot-backed providers for cases such as:

- context engines
- default memory providers
- future execution or planning engines

Required slot rules:

- each slot has a stable slot id
- each slot has a host-defined default
- explicit config selection wins
- only one active provider may own an exclusive slot
- migration preserves existing config semantics such as `plugins.slots.memory` and `plugins.slots.contextEngine`

Migration rule:

- slot-backed providers must move into host-owned registries before broader catalog and arbitration migration claims are considered complete

## Isolation Rules

The host must isolate extension failures from the kernel as much as possible.

Minimum requirements:

- one extension failing startup does not block unrelated extensions
- one contribution registration failure does not corrupt host state
- background-service failures transition the extension to `degraded` or `failed` without leaving stale registrations behind
- stop hooks are best-effort and time-bounded

In the current trusted in-process mode, "isolation" here means lifecycle and registry isolation, not a security sandbox.

## Reload And Upgrade Rules

Hot reload is optional. Deterministic restart behavior is required.

On reload or upgrade:

1. stop host-managed services
2. unregister contributions
3. clear host-owned route, command, backend, and slot registrations
4. clear dynamic account-scoped routes and stale runtime handles
5. instantiate the new version
6. reactivate only after validation and policy checks succeed

If the host continues to support config-driven hot reload during migration, it must also preserve:

- channel-owned reload prefix behavior equivalent to current `configPrefixes` and `noopPrefixes`
- gateway feature advertisement cleanup and re-registration
- setup-flow and native-command registrations that depend on account-scoped runtime state

This advertisement handling does not replace callable RPC registration. If a migrated extension exposes callable gateway-style methods, those should still be re-registered through `capability.rpc`.

During migration, keep the current built-in onboarding fallback in place until host-owned setup surfaces cover bundled channels with parity.

Pilot rule:

- the fallback stays in place until `telegram` parity has been recorded for setup-adjacent host behavior, even if runtime messaging parity lands earlier

## Operator Policy

The host should support policy controls for:

- allowed extension ids
- denied permissions
- default permission grants for bundled extensions
- allowed extension origins and provenance requirements
- origin precedence and duplicate resolution
- workspace extensions disabled by default unless explicitly allowed
- bundled channel auto-enable rules tied to channel config
- route exposure policy
- network egress policy
- backend selection policy
- whether external extensions are permitted at all
- SDK compatibility level and deprecation mode
- prompt-mutation policy defaults
- whether interactive extension-owned CLI and setup flows are allowed
- whether extension-owned native command registration is allowed on specific providers
- whether config-driven hot reload descriptors are honored or downgraded to restart-only behavior

## Observability

The host must emit structured telemetry for:

- activation timings
- policy denials
- contribution conflicts
- route conflicts
- backend registration and health
- service start and stop
- extension degradation and recovery
- provenance warnings and origin overrides
- state migration outcomes
- compatibility-mode activation and deprecated SDK usage
- setup flow phase transitions and fallback-path usage
- config redaction or restore validation failures
- reload descriptor application and gateway feature re-registration

## Immediate Implementation Work

1. Write the boundary cutover inventory for every current plugin-owned surface.
2. Introduce an extension-host lifecycle state machine.
3. Move route registration policy out of plugin internals into host-owned registries.
4. Add a policy evaluator that understands advisory versus enforced permission modes.
5. Add host-owned credential and per-extension state boundaries for extension services.
6. Generalize backend registration into a host-managed `capability.runtime-backend` registry.
7. Add slot-backed provider management for context engines and other exclusive runtime providers.
8. Preserve provenance, origin precedence, and current workspace and bundled enablement rules in host policy.
9. Preserve prompt-mutation policy gates and add explicit state migration handling.
10. Add explicit host registries and typed contracts for extension-owned hooks, channels, providers, tools, commands, CLI, setup flows, config surfaces, and status surfaces.
11. Preserve config redaction-aware schema behavior and current reload or gateway feature contracts during migration.
12. Record lifecycle parity for `thread-ownership` first and `telegram` second before broadening the compatibility bridges.
