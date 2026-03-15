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
- Phase 2 has started in a narrow, compatibility-preserving form but is not complete.
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
- loader mutable activation state now routes through `src/extension-host/loader-session.ts`
- loader activation policy outcomes now route through `src/extension-host/loader-activation-policy.ts`
- loader record-state transitions now route through `src/extension-host/loader-state.ts`, which now enforces an explicit loader lifecycle state machine while preserving compatibility `PluginRecord.status` values
- loader finalization policy results now route through `src/extension-host/loader-finalization-policy.ts`
- loader final cache, readiness promotion, and activation finalization now routes through `src/extension-host/loader-finalize.ts`
- runtime registration normalization has started in `src/extension-host/runtime-registrations.ts` for channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook registrations
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

How it has been done:

- by extracting narrow host-owned modules first and making existing plugin modules delegate to them
- by preserving current behavior and import surfaces wherever possible instead of attempting a broad rewrite
- by introducing normalized static records before touching heavy runtime activation paths
- by converting one static consumer at a time so each call site can move without forcing a loader rewrite
- by extracting low-risk runtime registration helpers next and letting `src/plugins/registry.ts` delegate to them as a compatibility facade
- by keeping duplicate enforcement in legacy subsystems only where that logic has not moved yet, such as plugin commands
- by starting loader and lifecycle migration with compatibility helpers for activation and SDK alias resolution before changing discovery or policy behavior
- by moving cache-key construction, cache reads, cache writes, and cache clearing behind host-owned helpers before changing activation-state ownership
- by extracting lazy runtime proxy creation and alias-wired Jiti module-loader creation into host-owned helpers before broader bootstrap or lifecycle ownership changes
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
- by moving mutable activation state such as seen-id tracking, memory-slot selection, and finalization inputs into a host-owned loader session instead of leaving them in top-level loader variables
- by extracting shared provenance path matching and install-rule evaluation into `src/extension-host/loader-provenance.ts` so activation and finalization policy seams reuse one host-owned implementation
- by turning open-allowlist discovery warnings into explicit host-owned discovery-policy results before the orchestrator logs them
- by moving duplicate precedence, config enablement, and early memory-slot gating into explicit host-owned activation-policy outcomes instead of leaving them inline in the loader flow
- by turning provenance-based untracked-extension warnings and final memory-slot warnings into explicit host-owned finalization-policy results before the finalizer applies them
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
- `89414ed857` `Docs: track extension host migration internally`
- `d8af1eceaf` `Docs: refresh extension host migration status`

What is still missing for these phases:

- keeping the cutover inventory current as more surfaces move
- broader lifecycle ownership beyond the loader state machine, session-owned activation state, and explicit discovery-policy, activation-policy, and finalization-policy outcomes, remaining policy gate ownership, and broad host-owned registries described for Phase 2
- minimal SDK compatibility work beyond preserving current behavior indirectly through existing loading
- any pilot migration, event pipeline, canonical catalog, or arbitration implementation

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
