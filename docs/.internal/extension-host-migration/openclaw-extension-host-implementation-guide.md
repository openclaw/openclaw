Temporary internal migration note: remove this document once the extension-host migration is complete.

# OpenClaw Extension Host Implementation Guide

Date: 2026-03-15

## Purpose

This is the main execution guide for implementing the extension-host and kernel transition.

Use it as the top-level implementation document.

## How We Fix It

Fix this as a staged architectural migration, not a broad refactor.

1. Lock the boundary first by writing the cutover inventory and adding anti-corruption interfaces so no new plugin-specific behavior leaks into the kernel.
2. Introduce source-of-truth extension schema types and the `ResolvedExtension` model while preserving current `openclaw/plugin-sdk/*` loading through minimal compatibility support.
3. Move discovery, policy, provenance, static metadata, and registration ownership into the extension host, including hooks, channels, providers, tools, routes, CLI, setup, services, and slot-backed providers.
4. Prove the path with pilot migrations: `thread-ownership` first for non-channel hook behavior, then `telegram` for channel compatibility.
5. After pilot parity is established, move runtime behavior onto canonical event stages and replace the fragmented tool, provider, and slot-selection paths with one catalog and arbitration model.
6. Remove the legacy plugin runtime as the default path only after the host path has parity and the duplicate legacy systems are gone or explicitly downgraded to compatibility-only shims.

The other docs remain the source of truth for their domains:

- `openclaw-extension-contribution-schema-spec.md`
- `openclaw-extension-host-lifecycle-and-security-spec.md`
- `openclaw-kernel-event-pipeline-spec.md`
- `openclaw-capability-catalog-and-arbitration-spec.md`
- `openclaw-kernel-extension-host-transition-plan.md`

## TODOs

- [ ] Confirm the implementation order and owners for each phase.
- [x] Create the initial code skeleton for kernel and extension-host boundaries.
- [x] Write the initial boundary cutover inventory for every current plugin-owned surface.
- [ ] Keep the boundary cutover inventory updated as surfaces move.
- [ ] Track PRs, migrations, and follow-up gaps by phase.
- [ ] Keep the linked spec TODO sections in sync with implementation progress.
- [ ] Define the detailed pilot migration matrix and parity checks before Phase 3 starts.
- [ ] Mark this guide complete only when the legacy plugin path is no longer the primary runtime path.

## Implementation Status

Current status against this guide:

- Phase 0 has started but is not complete.
- Phase 1 has started but is not complete.
- Phase 2 has started in a broad, compatibility-preserving form but is not complete.
- Phases 3 through 7 have not started in a meaningful way yet.

What has been implemented so far:

- a new `src/extension-host/*` boundary now exists in code
- active runtime registry ownership moved into `src/extension-host/active-registry.ts`
- `src/plugins/runtime.ts` now acts as a compatibility facade over the host-owned active registry
- registry activation now routes through `src/extension-host/activation.ts`
- initial source-of-truth types landed in `src/extension-host/schema.ts`, including `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy`
- static manifest and package metadata are now normalized through host-owned helpers rather than being interpreted only inside plugin-era modules
- `src/plugins/manifest-registry.ts` now carries a normalized `resolvedExtension` alongside the legacy flat manifest record
- `src/extension-host/resolved-registry.ts` now exposes a host-owned resolved-extension registry view
- an initial Phase 0 inventory now exists in `src/extension-host/cutover-inventory.md`
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
- loader host process state now routes through `src/extension-host/loader-host-state.ts`
- loader preflight and cache-hit setup now routes through `src/extension-host/loader-preflight.ts`
- loader post-preflight pipeline composition now routes through `src/extension-host/loader-pipeline.ts`
- loader execution setup composition now routes through `src/extension-host/loader-execution.ts`
- loader discovery and manifest bootstrap now routes through `src/extension-host/loader-bootstrap.ts`
- loader mutable activation state now routes through `src/extension-host/loader-session.ts`
- loader session run and finalization composition now routes through `src/extension-host/loader-run.ts`
- loader activation policy outcomes now route through `src/extension-host/loader-activation-policy.ts`
- loader record-state transitions now route through `src/extension-host/loader-state.ts`, which now enforces an explicit loader lifecycle state machine while preserving compatibility `PluginRecord.status` values
- loader finalization policy results now route through `src/extension-host/loader-finalization-policy.ts`
- loader final cache, readiness promotion, and activation finalization now routes through `src/extension-host/loader-finalize.ts`
- runtime registration normalization has started in `src/extension-host/runtime-registrations.ts` for channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook registrations
- low-risk runtime compatibility writes for channel, provider, gateway-method, HTTP-route, tool, CLI, service, command, context-engine, and hook registrations now route through `src/extension-host/registry-writes.ts`
- legacy internal-hook bridging and typed prompt-injection compatibility policy now route through `src/extension-host/hook-compat.ts`
- compatibility `OpenClawPluginApi` composition and logger shaping now route through `src/extension-host/plugin-api.ts`
- compatibility plugin-registry facade ownership now routes through `src/extension-host/plugin-registry.ts`
- compatibility plugin-registry policy now routes through `src/extension-host/plugin-registry-compat.ts`
- compatibility plugin-registry registration actions now route through `src/extension-host/plugin-registry-registrations.ts`
- host-owned runtime registry accessors now route through `src/extension-host/runtime-registry.ts`, and the provider, tool, HTTP-route, gateway-method, CLI, and service slices now keep host-owned storage there with mirrored legacy compatibility views
- service startup, stop ordering, service-context creation, and failure logging now route through `src/extension-host/service-lifecycle.ts`
- CLI duplicate detection, registrar invocation, and async failure logging now route through `src/extension-host/cli-lifecycle.ts`
- gateway method-id aggregation, plugin diagnostic shaping, and extra-handler composition now route through `src/extension-host/gateway-methods.ts`
- plugin tool resolution, conflict handling, optional-tool gating, and plugin-tool metadata tracking now route through `src/extension-host/tool-runtime.ts`
- plugin provider projection from registry entries into runtime provider objects now routes through `src/extension-host/provider-runtime.ts`
- plugin provider discovery filtering, order grouping, and result normalization now route through `src/extension-host/provider-discovery.ts`
- provider matching, auth-method selection, config-patch merging, and default-model application now route through `src/extension-host/provider-auth.ts`
- provider onboarding option building, model-picker entry building, and provider-method choice resolution now route through `src/extension-host/provider-wizard.ts`
- loaded-provider auth application, plugin-enable gating, auth-method execution, and post-auth default-model handling now route through `src/extension-host/provider-auth-flow.ts`
- provider post-selection hook lookup and invocation now route through `src/extension-host/provider-model-selection.ts`
- several static and lookup consumers now read through the host boundary or resolved-extension model:
  - channel registry and dock lookups
  - message-channel normalization
  - plugin HTTP route registry default lookup
  - discovery and install package metadata parsing
  - channel catalog package metadata parsing
  - plugin skill discovery
  - plugin auto-enable
  - config doc baseline generation
  - config validation indexing
- several runtime consumers now also read through host-owned runtime-registry accessors instead of touching raw plugin-registry arrays or handler maps directly:
  - provider projection
  - tool resolution
  - service lifecycle startup
  - CLI registration
  - gateway method aggregation
  - gateway plugin HTTP route matching
- the provider, tool, HTTP-route, gateway-method, CLI, and service slices now also keep host-owned runtime-registry storage with mirrored legacy compatibility arrays and handler maps
- `src/cli/plugin-registry.ts` now treats any pre-seeded runtime entry surface as already loaded, not just plugins, channels, or tools

How it has been done:

- by extracting narrow host-owned modules first and making existing plugin modules delegate to them
- by preserving current behavior and import surfaces wherever possible instead of attempting a broad rewrite
- by introducing normalized static records before touching heavy runtime activation paths
- by converting one static consumer at a time so each call site can move without forcing a loader rewrite
- by extracting low-risk runtime registration helpers next and letting `src/plugins/registry.ts` delegate to them as a compatibility facade
- by starting actual low-risk runtime write ownership next for channel, provider, gateway-method, HTTP-route, tool, CLI, service, command, context-engine, and hook registrations while keeping duplicate enforcement and lifecycle semantics in legacy owners where that behavior still lives
- by keeping duplicate enforcement in legacy subsystems only where that logic has not moved yet, such as plugin commands
- by starting loader and lifecycle migration with compatibility helpers for activation and SDK alias resolution before changing discovery or policy behavior
- by moving cache-key construction, cache reads, cache writes, and cache clearing behind host-owned helpers before changing activation-state ownership
- by extracting lazy runtime proxy creation and alias-wired Jiti module-loader creation into host-owned helpers before broader bootstrap or lifecycle ownership changes
- by extracting discovery, manifest loading, manifest diagnostics, discovery-policy logging, provenance building, and candidate ordering into a host-owned loader-bootstrap helper before broader lifecycle ownership changes
- by extracting candidate iteration, manifest lookup, per-candidate session processing, and finalization handoff into a host-owned loader-run helper before broader lifecycle ownership changes
- by moving loader-owned policy helpers next, while keeping module loading and enablement flow behavior unchanged
- by moving initial candidate planning and record construction behind host-owned helpers before changing import and registration flow
- by moving entry-path opening and module import behind host-owned helpers before changing cache wiring or lifecycle orchestration
- by moving loader runtime decisions behind host-owned helpers while preserving lazy loading, config validation behavior, and memory-slot policy behavior
- by moving post-import planning and `register(...)` execution behind host-owned helpers before changing entry-path and import flow
- by composing those seams into one host-owned per-candidate orchestrator before changing cache and lifecycle finalization behavior
- by moving loader record-state transitions into host-owned helpers before enforcing them as a loader lifecycle state machine
- by moving cache writes, provenance warnings, final memory-slot warnings, and activation into a host-owned loader finalizer before introducing an explicit lifecycle state machine
- by adding explicit compatibility `lifecycleState` mapping on loader-owned plugin records before enforcing the loader lifecycle state machine
- by turning that compatibility `lifecycleState` field into an enforced loader lifecycle state machine with readiness promotion during finalization
- by moving the remaining top-level loader orchestration into a host-owned module so `src/plugins/loader.ts` becomes a compatibility facade instead of the real owner
- by extracting shared discovery warning-cache state and loader reset behavior into a host-owned loader-host-state helper before shrinking the remaining orchestrator surface
- by extracting test-default application, config normalization, cache-key construction, cache-hit activation, and command-clear setup into a host-owned loader-preflight helper before shrinking the remaining orchestrator surface
- by extracting post-preflight execution setup and session-run composition into a host-owned loader-pipeline helper before shrinking the remaining orchestrator surface
- by extracting runtime creation, registry creation, bootstrap setup, module-loader creation, and session creation into a host-owned loader-execution helper before shrinking the remaining orchestrator surface
- by moving mutable activation state such as seen-id tracking, memory-slot selection, and finalization inputs into a host-owned loader session instead of leaving them in top-level loader variables
- by extracting shared provenance path matching and install-rule evaluation into `src/extension-host/loader-provenance.ts` so activation and finalization policy seams reuse one host-owned implementation
- by turning open-allowlist discovery warnings into explicit host-owned discovery-policy results before the orchestrator logs them
- by moving duplicate precedence, config enablement, and early memory-slot gating into explicit host-owned activation-policy outcomes instead of leaving them inline in the loader flow
- by turning provenance-based untracked-extension warnings and final memory-slot warnings into explicit host-owned finalization-policy results before the finalizer applies them
- by extracting legacy internal-hook bridging and typed prompt-injection compatibility policy into a host-owned hook-compat helper while leaving actual hook execution ownership unchanged
- by extracting compatibility `OpenClawPluginApi` composition and logger shaping into a host-owned plugin-api helper while keeping the concrete registration callbacks in the legacy registry surface
- by extracting the remaining compatibility plugin-registry facade into a host-owned helper so `src/plugins/registry.ts` becomes a thin wrapper instead of the real owner
- by extracting provider normalization, command duplicate enforcement, and registry-local diagnostic shaping into a host-owned registry-compat helper while leaving the underlying provider-validation and plugin-command subsystems unchanged
- by extracting low-risk registry registration actions into a host-owned registry-registrations helper so the compatibility facade composes host-owned actions instead of implementing them inline
- by extracting service startup, stop ordering, service-context creation, and failure logging into a host-owned service-lifecycle helper while `src/plugins/services.ts` remains the compatibility entry point
- by extracting CLI duplicate detection, registrar invocation, and async failure logging into a host-owned CLI-lifecycle helper while `src/plugins/cli.ts` remains the compatibility entry point
- by extracting gateway method-id aggregation, plugin diagnostic shaping, and extra-handler composition into a host-owned gateway-methods helper while request dispatch semantics remain in the gateway server code
- by extracting plugin tool resolution, conflict handling, optional-tool gating, and plugin-tool metadata tracking into a host-owned tool-runtime helper while `src/plugins/tools.ts` remains the loader and config-normalization facade
- by extracting provider projection from registry entries into runtime provider objects into a host-owned provider-runtime helper while `src/plugins/providers.ts` remains the loader and config-normalization facade
- by extracting provider discovery filtering, order grouping, and result normalization into a host-owned provider-discovery helper while `src/plugins/provider-discovery.ts` remains the compatibility facade around the legacy provider loader path
- by extracting provider matching, auth-method selection, config-patch merging, and default-model application into a host-owned provider-auth helper while `src/commands/provider-auth-helpers.ts` remains the command-facing compatibility facade
- by extracting provider onboarding option building, model-picker entry building, and provider-method choice resolution into a host-owned provider-wizard helper while `src/plugins/provider-wizard.ts` remains the compatibility facade around loader-backed provider access and post-selection hooks
- by extracting loaded-provider auth application, plugin-enable gating, auth-method execution, and post-auth default-model handling into a host-owned provider-auth-flow helper while `src/commands/auth-choice.apply.plugin-provider.ts` remains the compatibility entry point
- by extracting provider post-selection hook lookup and invocation into a host-owned provider-model-selection helper while `src/plugins/provider-wizard.ts` remains the compatibility facade and existing command consumers continue migrating onto the host-owned surface
- by extracting provider-id normalization into `src/agents/provider-id.ts` so provider-only host seams do not inherit the heavier agent and browser dependency graph from `src/agents/model-selection.ts`
- by extracting model-ref parsing into `src/agents/model-ref.ts` and Google model-id normalization into `src/agents/google-model-id.ts` so provider auth and setup seams can be tested without pulling the heavier provider-loader and browser dependency graph
- by introducing host-owned runtime-registry accessors for low-risk runtime consumers first, then moving provider, tool, HTTP-route, gateway-method, CLI, and service storage into that host-owned state while keeping mirrored legacy compatibility arrays and handler maps
- by tightening the CLI pre-load fast path to treat any host-known runtime entry surface as already loaded rather than only plugins, channels, or tools
- by moving central readers first, so later lifecycle and compatibility work can land on one boundary instead of many ad hoc call sites
- by adding focused tests for each extracted seam before widening the boundary further

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
- `97e2af7f97` `Plugins: add loader discovery policy`
- `83b18eab72` `Plugins: share loader provenance helpers`
- `52495d23d5` `Plugins: extract loader runtime factories`
- `6e187ffb62` `Plugins: extract loader bootstrap`
- `234a540720` `Plugins: extract loader session runner`
- `a98443c39d` `Plugins: extract loader execution setup`
- `c9323aa016` `Plugins: extract loader preflight`
- `0df51ae6b4` `Plugins: extract loader pipeline`
- `e557b39cb2` `Plugins: extract loader host state`
- `07c3ae9c87` `Plugins: extract low-risk registry writes`
- `bc71592270` `Plugins: extend registry write helpers`
- `27fc645484` `Plugins: extend registry writes for hooks`
- `b407d7f476` `Plugins: extract hook compatibility`
- `a1e1dcc01a` `Plugins: extract plugin api facade`
- `0e190d64d4` `Plugins: extract registry compatibility facade`
- `944d787df1` `Plugins: extract registry compatibility policy`
- `4ca9cd7e5e` `Plugins: extract registry registration actions`
- `6b24e65719` `Plugins: extract service lifecycle`
- `b5757a6625` `Plugins: extract CLI lifecycle`
- `e0e3229bcb` `Gateway: extract extension host method surface`
- `af7ac14eed` `Plugins: extract tool runtime`
- `19087405d2` `Plugins: extract provider runtime`
- `1303419471` `Plugins: extract provider discovery`
- `afb6e4b185` `Plugins: extract provider auth and wizard flows`
- `cc3d59d59e` `Plugins: extract provider auth application flow`
- `e6cd834f8e` `Plugins: extract provider model selection hook`
- `11cbe08ec6` `Plugins: add host-owned route and gateway storage`
- `ad0c235d16` `Plugins: add host-owned CLI and service storage`
- `2be54e9861` `Plugins: add host-owned tool and provider storage`
- `89414ed857` `Docs: track extension host migration internally`
- `d8af1eceaf` `Docs: refresh extension host migration status`

What is still missing for these phases:

- keeping the cutover inventory current as more surfaces move
- broader lifecycle ownership beyond the loader state machine, service-lifecycle boundary, CLI-lifecycle boundary, session-owned activation state, and explicit discovery-policy, activation-policy, and finalization-policy outcomes, remaining policy gate ownership, and broad host-owned registries described for Phase 2
- minimal SDK compatibility work beyond preserving current behavior indirectly through existing loading
- host-owned conversation binding, interaction routing, ingress claim, and generic interactive control surfaces
- host-owned subsystem runtime registries for embeddings, media understanding, and TTS
- explicit support for extension-backed search, with a generic split between agent-visible tool publication and optional runtime-internal search backends
- any pilot migration, event pipeline, canonical catalog, or arbitration implementation

Recent plan refinements:

- the plan now explicitly treats conversation binding ownership, approval persistence, restore-on-restart behavior, and detached-binding cleanup as first-class migration surfaces
- it now explicitly treats interactive callback routing, namespace ownership, dedupe, and fallback behavior as first-class migration surfaces
- it now explicitly treats inbound claim as a canonical ingress-stage concern rather than a permanent plugin-era hook shape
- it now explicitly treats Telegram and Discord as the first validated rollout targets for interactive control surfaces while keeping the underlying contracts generic, host-owned, and kernel-agnostic
- it now explicitly treats embeddings, media understanding, and TTS as host-owned subsystem runtimes with capability routing, typed request envelopes, provider-id normalization, and fallback policy
- it now explicitly rejects widening the legacy `registerProvider(...)` or `ProviderPlugin` surface into a universal runtime API while retaining capability routing, typed request envelopes, provider-id normalization, and fallback behavior where those are part of the target model
- it now explicitly treats extension-backed search as either a canonical tool contribution or a host-owned runtime backend depending on whether the search surface is agent-visible

## Implementation Order

Implement phases in this order:

1. Phase 0: boundary inventory and anti-corruption layer
2. Phase 1: contribution schema, package metadata, and minimal SDK compatibility
3. Phase 2: extension host lifecycle and registries
4. Phase 3: broader legacy compatibility bridges
5. Phase 4: canonical event pipeline
6. Phase 5: capability catalog migration
7. Phase 6: arbitration migration
8. Phase 7: broader migration and legacy removal

This order matters because each layer depends on the previous one:

- catalogs depend on normalized contributions
- normalized contributions depend on host discovery and validation
- existing extensions must keep loading while the schema and SDK boundary changes
- migrated hooks depend on the canonical event pipeline
- install, onboarding, and status flows depend on static metadata before runtime activation
- catalogs and arbitration already exist in partial forms, so their phases are migrations, not greenfield work
- useful ideas from implementation review should be harvested as parity requirements and host-owned capabilities, not by broadening legacy `src/plugins/*` or `src/plugin-sdk/*` surfaces as the target architecture
- safe removal of legacy paths depends on compatibility coverage and parity checks

## Implementation Guardrails

Do not implement every abstraction in the docs in the first cut.

Treat some parts of the design as ceilings rather than immediate scope:

- event taxonomy should start with three execution modes only:
  - parallel observers
  - sequential merge or decision handlers
  - sync transcript hot paths
- permission modes should implement `advisory` and `host-enforced` first
- `sandbox-enforced` should remain a future contract until real isolation exists
- catalog publication should start small:
  - kernel internal catalog
  - kernel agent catalog
  - host operator and static registries
- adapter metadata should stay minimal and parity-driven
- setup flow typing should start with a small result set:
  - config patch
  - credential result
  - status note
  - follow-up action
- canonical action governance should start as one source file plus tests, not a larger process framework
- arbitration should start with:
  - exclusive slot
  - ranked provider
  - parallel provider

The first implementation goal is parity for pilot migrations, not maximum generality.

If a design choice is not required to migrate one channel extension and one non-channel extension safely, defer it.

## Current Runtime Surfaces That Must Be Accounted For

The current plugin system already owns more than runtime activation.

Before implementation starts, write and maintain a cutover inventory for these surfaces:

- manifest loading and static metadata
- package-level install and onboarding metadata
- discovery, provenance, and origin precedence
- config schema and UI hint loading
- typed hooks and legacy hook bridges
- channels and channel lookup
- providers and provider auth/setup flows
- tools and agent-visible tool catalogs
- HTTP routes and gateway methods
- CLI registrars and plugin commands
- services and context-engine registrations
- slot selection and other existing arbitration paths
- status, reload, install, update, and diagnostics surfaces

Do not treat Phase 5 and Phase 6 as new systems built in isolation.

They must absorb and replace the existing partial catalog and arbitration behaviors rather than creating a second source of truth.

## Phase Guide

### Phase 0: Lock the boundary

Goal:

- define the kernel versus extension-host boundary in code and imports
- inventory every current plugin-owned surface that crosses that boundary

Deliverables:

- boundary cutover inventory
- anti-corruption interfaces for host-owned registration surfaces
- initial feature flags for host-path versus legacy-path execution
- directory and import boundaries for kernel and extension-host code

Primary docs:

- `openclaw-kernel-extension-host-transition-plan.md`
- `openclaw-extension-contribution-schema-spec.md`

Exit criteria:

- kernel code does not take new dependencies on legacy plugin shapes
- extension-host directory structure exists
- compatibility-only surfaces are identified
- each current plugin-owned surface is tagged as kernel-owned, host-owned, or compatibility-only
- no new direct writes to global registries are introduced without going through the new boundary

Current implementation status:

- partially implemented
- the code boundary exists in `src/extension-host/*`
- central active-registry ownership now routes through the host boundary
- several central runtime readers now consume the host-owned boundary instead of reading directly from `src/plugins/runtime.ts`
- the initial cutover inventory now exists in `src/extension-host/cutover-inventory.md` and is being updated as surfaces move, but the phase is still incomplete because loader orchestration, lifecycle ownership, and later compatibility phases have not moved yet

### Phase 1: Define the schema

Goal:

- implement the source-of-truth manifest and contribution types
- preserve existing extension loading while the schema and SDK boundary changes

Primary doc:

- `openclaw-extension-contribution-schema-spec.md`

Deliverables:

- manifest parser
- package metadata parser
- contribution validators
- `ResolvedExtension`
- `ResolvedContribution`
- typed `ContributionPolicy`
- static metadata parser
- new versioned SDK contract surface
- minimal SDK compatibility loading surface
- normalized install and onboarding metadata model

Exit criteria:

- extensions can be normalized into static and runtime sections without activating heavy runtime code
- existing extension SDK imports still resolve through the compatibility loading path

Current implementation status:

- partially implemented
- `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy` landed as initial code types
- legacy manifest and package metadata now converge into a normalized `resolvedExtension` record carried by the manifest registry
- discovery, install, and catalog metadata parsing now go through host-owned schema helpers
- partial explicit compatibility now exists through host-owned loader-compat and loader-runtime helpers, but full manifest or contribution validators and a versioned SDK compatibility layer are not implemented yet

### Phase 2: Build the extension host

Goal:

- implement discovery, validation, policy, registries, and lifecycle ownership

Primary doc:

- `openclaw-extension-host-lifecycle-and-security-spec.md`

Deliverables:

- discovery pipeline
- activation state machine
- policy evaluator
- host-owned registries
- host-owned adapters for hooks, channels, providers, tools, HTTP routes, gateway methods, CLI, services, commands, and context engines
- per-extension state ownership
- provenance and origin handling
- config redaction-aware schema loading
- reload and route ownership handling

Exit criteria:

- the host can load bundled and external extensions into normalized registries
- the host can populate normalized registries without direct kernel writes except through explicit compatibility adapters

Current implementation status:

- partially implemented in a compatibility-preserving form
- the host owns the active registry state
- the host exposes a resolved-extension registry view for static consumers
- plugin skills, plugin auto-enable, and config validation indexing now consume host-owned resolved-extension data
- activation, loader cache control, loader policy, loader discovery-policy outcomes, loader activation-policy outcomes, loader finalization-policy outcomes, loader candidate planning, loader import flow, loader runtime decisions, loader post-import register flow, loader candidate orchestration, loader top-level load orchestration, loader session state, loader record-state helpers, and loader finalization now route through `src/extension-host/*`
- broader lifecycle state ownership beyond the loader state machine, activation states, policy evaluation, and broad host-owned registries are still not implemented

### Phase 3: Build compatibility bridges

Goal:

- keep current extensions working through the host without leaking legacy contracts into the kernel

Primary docs:

- `openclaw-kernel-extension-host-transition-plan.md`
- `openclaw-extension-contribution-schema-spec.md`

Deliverables:

- `ChannelPlugin` compatibility translators
- plugin SDK compatibility loading
- runtime-channel namespace translation into the new SDK modules
- legacy setup and CLI translation
- legacy config schema and UI hint translation
- pilot migration matrix with explicit parity labels

Exit criteria:

- `thread-ownership` runs through the host path as the first non-channel pilot
- `telegram` runs through the host path as the first channel pilot
- both pilots have explicit parity results for discovery, config, activation, diagnostics, and runtime behavior

### Phase 4: Implement the canonical event pipeline

Goal:

- move runtime hook behavior onto explicit canonical events

Primary doc:

- `openclaw-kernel-event-pipeline-spec.md`

Deliverables:

- event type definitions
- stage runner
- sync transcript-write stages
- bridges from legacy hook buses
- mapping table from existing typed and legacy hooks to canonical stages

Exit criteria:

- migrated extensions can use canonical events without relying directly on old plugin hook execution
- pilot hook behaviors have parity coverage against the pre-host path

### Phase 5: Implement catalogs

Goal:

- compile runtime-derived agent and internal catalogs, plus host-owned operator catalogs
- replace existing plugin-identity-driven catalog surfaces with canonical family-based catalogs

Primary doc:

- `openclaw-capability-catalog-and-arbitration-spec.md`

Deliverables:

- kernel internal catalog
- kernel agent catalog
- host operator catalog
- static setup and install catalogs
- canonical action registry
- migration plan for existing tool, provider, and setup catalog surfaces

Exit criteria:

- agent-visible tools are compiled from canonical action families instead of plugin identity
- setup and install catalogs no longer depend on duplicated legacy metadata paths

### Phase 6: Implement arbitration

Goal:

- resolve overlap, ranking, selection, and slot conflicts deterministically
- absorb the existing slot and provider selection behavior into canonical arbitration

Primary doc:

- `openclaw-capability-catalog-and-arbitration-spec.md`

Deliverables:

- conflict detection
- provider selection
- slot arbitration
- planner-visible name collision handling
- migration plan for existing slot and name-collision behaviors

Exit criteria:

- at least one multi-provider family works through canonical arbitration
- legacy slot and provider-selection paths no longer act as separate arbitration systems

### Phase 7: Migrate and remove legacy paths

Goal:

- finish migration and shrink compatibility-only surfaces

Primary docs:

- `openclaw-kernel-extension-host-transition-plan.md`
- all other docs as parity references

Deliverables:

- channel migrations
- non-channel extension migrations
- parity tests
- deprecation markers
- removal plan for obsolete compatibility shims

Exit criteria:

- legacy plugin runtime is no longer the default execution path

## Pilot Matrix

Initial pilot set:

- non-channel pilot: `thread-ownership`
- channel pilot: `telegram`

Why these pilots:

- `thread-ownership` exercises typed hook loading without introducing CLI, HTTP route, or service migration at the same time
- `telegram` exercises the `ChannelPlugin` compatibility path with a minimal top-level plugin registration surface

Second-wave compatibility candidates after the pilots are stable:

- `line` for channel plus command registration
- `device-pair` for command, service, and setup flow coverage

Each pilot must record parity for:

- discovery and precedence
- manifest and static metadata loading
- config schema and UI hints
- enabled and disabled state handling
- activation and reload behavior
- diagnostics and status output
- runtime behavior on the migrated path
- compatibility-only gaps that still remain

## Recommended First Implementation Slice

If you want the lowest-risk start, do this first:

1. write the boundary cutover inventory
2. add source-of-truth types
3. add the static metadata and package metadata parsers
4. add `ResolvedExtension`
5. add minimal SDK compatibility loading
6. add host discovery and validation
7. bring `thread-ownership` through the host path first
8. bring `telegram` through the host path second

Status of this slice:

- steps 2 through 6 are underway
- step 1 has landed as `src/extension-host/cutover-inventory.md`
- steps 7 and 8 have not started

Concrete landings from this slice:

- the host boundary exists
- source-of-truth schema types exist
- package metadata parsing now routes through the host schema layer
- `ResolvedExtension` exists in code and is attached to manifest-registry records
- host-owned active-registry and resolved-registry views exist
- early static consumers have moved onto the new host-owned data path

Do not start with catalogs or arbitration first.

Also avoid these first-cut traps:

- do not build a broad event scheduling framework before the canonical stages exist
- do not turn permission descriptors into fake sandbox guarantees
- do not build a large operator catalog publication layer before the host registries are real
- do not over-type setup flows before the pilot migrations prove the minimum result model is insufficient

## Tracking Rules

When implementation begins:

- update this guide first with phase status
- update the matching spec TODOs when a domain changes
- record where the implementation intentionally diverged from the spec
- record which behaviors are full parity, partial parity, or compatibility-only
- update the pilot parity matrix whenever a migrated surface changes

## Suggested Status Format

Use this format in each doc when work starts:

- `not started`
- `in progress`
- `implemented`
- `verified`
- `deferred`

For example:

- `ResolvedExtension` registry: `implemented`
- setup fallback removal: `deferred`
- sync transcript-write parity tests: `in progress`
