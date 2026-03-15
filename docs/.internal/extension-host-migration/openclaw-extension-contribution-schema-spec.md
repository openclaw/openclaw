Temporary internal migration note: remove this document once the extension-host migration is complete.

# OpenClaw Extension Contribution Schema Spec

Date: 2026-03-15

## Purpose

This document defines the concrete schema the extension host uses to convert extension packages into resolved runtime contributions for the kernel.

The kernel must never parse plugin manifests or interpret package layout directly. It only receives validated contribution objects.

## TODOs

- [ ] Finalize TypeScript source-of-truth types for `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy`.
- [ ] Implement manifest and contribution validators from this schema.
- [ ] Lock the static distribution metadata shape, including full channel catalog parity fields.
- [ ] Lock the package metadata and static distribution parsing contract used by install, onboarding, status, and lightweight UX flows.
- [ ] Lock the `surface.config`, `surface.setup`, and `capability.control-command` descriptor shapes.
- [ ] Preserve minimal SDK compatibility loading while this schema replaces legacy runtime assumptions.
- [ ] Record pilot parity and schema adjustments for `thread-ownership` first and `telegram` second.
- [ ] Record any schema changes discovered during the first pilot migration.

## Implementation Status

Current status against this spec:

- the initial source-of-truth types have landed in code, but they are not final
- static normalization work has started
- validators and explicit compatibility translation work have not landed

What has been implemented:

- an initial Phase 0 cutover inventory now exists in `src/extension-host/cutover-inventory.md`
- `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy` now exist in `src/extension-host/schema.ts`
- a legacy-to-normalized adapter now builds `ResolvedExtension` records from current plugin manifests and package metadata
- package metadata parsing for discovery, install, and channel catalog paths now routes through host-owned schema helpers
- manifest-registry records now carry a normalized `resolvedExtension`
- a host-owned resolved-extension registry now exists for static consumers
- config doc baseline generation now reads bundled extension metadata through the resolved-extension registry
- the first runtime registration normalization helpers now exist in `src/extension-host/runtime-registrations.ts` for channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook writes
- low-risk runtime compatibility writes for channel, provider, gateway-method, HTTP-route, tool, CLI, service, command, context-engine, and hook registrations now route through `src/extension-host/registry-writes.ts`
- context-engine registration and runtime resolution now route through `src/extension-host/context-engine-runtime.ts` while `src/context-engine/registry.ts` remains the compatibility facade
- exclusive-slot selection and default-slot resolution now route through `src/extension-host/slot-arbitration.ts` while `src/plugins/slots.ts` remains the compatibility facade
- ACP backend registration and runtime resolution now route through `src/extension-host/acp-runtime-backend-registry.ts` while `src/acp/runtime/registry.ts` remains the compatibility facade
- embedding-provider auto-selection, provider creation, local-setup guidance, and primary and fallback routing now route through `src/extension-host/embedding-runtime-registry.ts`, the public embedding runtime surface and result typing now route through `src/extension-host/embedding-runtime.ts` and `src/extension-host/embedding-runtime-types.ts`, and manager-side batch policy plus fallback activation now route through `src/extension-host/embedding-manager-runtime.ts` while `src/memory/embeddings.ts` remains the compatibility facade
- media-provider normalization, built-in registry construction, override merging, and runtime lookup now route through `src/extension-host/media-runtime-registry.ts`; provider and CLI entry execution, output parsing, provider query normalization, provider auth/context shaping, and proxy-aware fetch handling now route through `src/extension-host/media-runtime-execution.ts`; local-binary probing, auto-entry selection, active-model fallback, and top-level capability orchestration now route through `src/extension-host/media-runtime-auto.ts` and `src/extension-host/media-runtime-orchestration.ts`; and media prompt, timeout, scope, model-entry, concurrency, and decision helpers now route through `src/extension-host/media-runtime-config.ts` and `src/extension-host/media-runtime-decision.ts` while `src/media-understanding/providers/index.ts`, `src/media-understanding/runner.ts`, `src/media-understanding/runner.entries.ts`, and `src/media-understanding/resolve.ts` remain compatibility facades
- TTS provider metadata, provider ordering, API-key resolution, configuration checks, and telephony support now route through `src/extension-host/tts-runtime-registry.ts`, provider execution loops, output-format selection, telephony synthesis, and provider-error shaping now route through `src/extension-host/tts-runtime-execution.ts`, provider selection plus request setup now route through `src/extension-host/tts-runtime-setup.ts`, prefs-path resolution, auto-mode policy, and persisted TTS preference reads and writes now route through `src/extension-host/tts-preferences.ts`, and auto-TTS gating, directive cleanup, truncation, summarization, and payload planning now route through `src/extension-host/tts-payload.ts` while `src/tts/tts.ts` remains the compatibility facade plus config and attempt-status surface
- legacy internal-hook bridging and typed prompt-injection compatibility policy now route through `src/extension-host/hook-compat.ts`
- compatibility `OpenClawPluginApi` composition and logger shaping now route through `src/extension-host/plugin-api.ts`
- compatibility plugin-registry facade ownership now routes through `src/extension-host/plugin-registry.ts`
- compatibility plugin-registry policy now routes through `src/extension-host/plugin-registry-compat.ts`
- compatibility plugin-registry registration actions now route through `src/extension-host/plugin-registry-registrations.ts`
- service startup, stop ordering, service-context creation, and failure logging now route through `src/extension-host/service-lifecycle.ts`
- CLI duplicate detection, registrar invocation, and async failure logging now route through `src/extension-host/cli-lifecycle.ts`
- gateway method-id aggregation, plugin diagnostic shaping, and extra-handler composition now route through `src/extension-host/gateway-methods.ts`
- plugin tool resolution, conflict handling, optional-tool gating, and plugin-tool metadata tracking now route through `src/extension-host/tool-runtime.ts`
- plugin provider projection from registry entries into runtime provider objects now route through `src/extension-host/provider-runtime.ts`
- channel registrations now also keep host-owned runtime-registry storage with mirrored legacy compatibility views, and channel readers now consume the same host-owned boundary
- provider, tool, and command registrations now also keep host-owned runtime-registry storage with mirrored legacy compatibility views
- plugin command registration, matching, execution, listing, and native command-spec projection now route through `src/extension-host/command-runtime.ts` while `src/plugins/commands.ts` remains the compatibility facade
- plugin provider discovery filtering, order grouping, and result normalization now route through `src/extension-host/provider-discovery.ts`
- provider matching, auth-method selection, config-patch merging, and default-model application now route through `src/extension-host/provider-auth.ts`
- provider onboarding option building, model-picker entry building, and provider-method choice resolution now route through `src/extension-host/provider-wizard.ts`
- loaded-provider auth application, plugin-enable gating, auth-method execution, and post-auth default-model handling now route through `src/extension-host/provider-auth-flow.ts`
- provider post-selection hook lookup and invocation now route through `src/extension-host/provider-model-selection.ts`
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

How it has been implemented:

- by wrapping current manifest and package metadata rather than replacing the plugin loader outright
- by introducing a compatibility-oriented `resolveLegacyExtensionDescriptor(...)` path first
- by moving static metadata consumers onto the normalized model before attempting runtime contribution migration
- by keeping legacy manifest records available only as compatibility projections while new readers move to the normalized shape
- by starting runtime contribution migration with normalization helpers that preserve the legacy plugin API surface
- by starting actual low-risk runtime write ownership for channel, provider, gateway-method, HTTP-route, tool, CLI, service, command, context-engine, and hook registrations only after normalization helpers preserved the legacy plugin API surface
- by making cache-key construction and registry cache control explicit host-owned seams before changing loader activation-state ownership
- by making the first loader compatibility, candidate-planning, import-flow, runtime-decision, register-flow, candidate-orchestration, top-level load orchestration, record-state with compatibility lifecycle mapping, and finalization helpers explicit host-owned seams before introducing a versioned compatibility layer
- by extracting lazy runtime proxy creation and alias-wired Jiti module-loader creation into host-owned helpers before broader schema-driven lifecycle ownership changes
- by extracting discovery, manifest loading, manifest diagnostics, discovery-policy logging, provenance building, and candidate ordering into a host-owned loader-bootstrap helper before broader schema-driven lifecycle ownership changes
- by extracting candidate iteration, manifest lookup, per-candidate session processing, and finalization handoff into a host-owned loader-run helper before broader schema-driven lifecycle ownership changes
- by turning the compatibility record-state layer into an enforced loader lifecycle state machine before broadening the schema-driven host lifecycle model
- by extracting shared discovery warning-cache state and loader reset behavior into a host-owned loader-host-state helper before broadening the schema-driven host lifecycle model
- by extracting test-default application, config normalization, cache-key construction, cache-hit activation, and command-clear setup into a host-owned loader-preflight helper before broadening the schema-driven host lifecycle model
- by extracting post-preflight execution setup and session-run composition into a host-owned loader-pipeline helper before broadening the schema-driven host lifecycle model
- by extracting runtime creation, registry creation, bootstrap setup, module-loader creation, and session creation into a host-owned loader-execution helper before broadening the schema-driven host lifecycle model
- by moving mutable activation state into a host-owned loader session before broadening the schema-driven host lifecycle model
- by extracting shared provenance path matching and install-rule evaluation into `src/extension-host/loader-provenance.ts` so activation and finalization policy seams reuse one host-owned implementation
- by turning open-allowlist discovery warnings into explicit host-owned discovery-policy results before broadening the schema-driven host lifecycle model
- by moving duplicate precedence, config enablement, and early memory-slot gating into explicit host-owned activation-policy outcomes before broadening the schema-driven host lifecycle model
- by turning provenance-based untracked-extension warnings and final memory-slot warnings into explicit host-owned finalization-policy results before broadening the schema-driven host lifecycle model
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
- by moving channel registration storage into host-owned runtime-registry state after channel lookup readers were already on the host boundary, while keeping mirrored legacy compatibility arrays
- by moving provider and tool registration storage into host-owned runtime-registry state after their runtime readers were already host-owned, while keeping mirrored legacy compatibility arrays
- by extracting provider discovery filtering, order grouping, and result normalization into a host-owned provider-discovery helper while `src/plugins/provider-discovery.ts` remains the compatibility facade around the legacy provider loader path
- by extracting provider matching, auth-method selection, config-patch merging, and default-model application into a host-owned provider-auth helper while `src/commands/provider-auth-helpers.ts` remains the command-facing compatibility facade
- by extracting provider onboarding option building, model-picker entry building, and provider-method choice resolution into a host-owned provider-wizard helper while `src/plugins/provider-wizard.ts` remains the compatibility facade around loader-backed provider access and post-selection hooks
- by extracting loaded-provider auth application, plugin-enable gating, auth-method execution, and post-auth default-model handling into a host-owned provider-auth-flow helper while `src/commands/auth-choice.apply.plugin-provider.ts` remains the compatibility entry point
- by extracting provider post-selection hook lookup and invocation into a host-owned provider-model-selection helper while `src/plugins/provider-wizard.ts` remains the compatibility facade and existing command consumers continue migrating onto the host-owned surface
- by extracting provider-id normalization into `src/agents/provider-id.ts` so provider-only host seams do not inherit the heavier agent and browser dependency graph from `src/agents/model-selection.ts`
- by extracting model-ref parsing into `src/agents/model-ref.ts` and Google model-id normalization into `src/agents/google-model-id.ts` so provider auth and setup seams can be tested without pulling the heavier provider-loader and browser dependency graph

What remains pending:

- final schema shape
- manifest and contribution validators
- explicit `surface.setup` and `capability.control-command` descriptor work
- minimal SDK compatibility loading as an intentional, versioned compatibility layer rather than the current host-owned helper layering around the old loader path

## Design Goals

- one schema for bundled and external extensions
- one contribution model for channels, auth, memory, tools, ACP, voice, diffs, and future extension types
- explicit ids, scopes, dependencies, permissions, and arbitration metadata
- lightweight static descriptors for install, onboarding, and shared UX paths
- truthful permission semantics that do not imply sandboxing where none exists
- preserve prompt-mutation policy and adapter UX descriptors that exist outside simple send and receive
- enough structure for the host to detect conflicts before activation

## Sequencing Constraints

This schema must be introduced without breaking current extension loading.

Therefore:

- the first implementation cut must preserve current `openclaw/plugin-sdk/*` imports through compatibility loading
- static distribution metadata must be modeled as first-class schema, not deferred until after runtime contribution migration
- package-level metadata and manifest-level metadata must converge into one normalized `ResolvedExtension` model
- the first pilots should be `thread-ownership` first and `telegram` second, because they validate different schema surfaces with limited extra migration noise

## Runtime Boundary

The package or bundle unit is an extension.

The runtime unit is a contribution.

One extension may emit many contributions. The extension host is responsible for:

- loading the extension manifest
- validating all contribution descriptors
- rejecting or isolating invalid contributions
- constructing resolved contribution objects for the kernel
- preserving static host-owned descriptors used by install, onboarding, and status UX

## Manifest Shape

Recommended manifest shape:

```json
{
  "id": "openclaw.discord",
  "name": "Discord",
  "version": "2026.3.0",
  "apiVersion": "1.0",
  "entry": "./index.ts",
  "description": "Discord transport and interaction support",
  "bundled": true,
  "permissionMode": "advisory",
  "tags": ["channel", "messaging"],
  "dependencies": {
    "requires": [],
    "optional": []
  },
  "permissions": [
    "runtime.adapter",
    "network.outbound",
    "credentials.read",
    "credentials.write",
    "http.route.gateway"
  ],
  "config": {
    "schema": {},
    "uiHints": {}
  },
  "distribution": {
    "install": {
      "entries": ["./dist/index.js"],
      "npmSpec": "@openclaw/discord",
      "defaultChoice": "npm"
    },
    "catalog": {
      "channels": [
        {
          "id": "discord",
          "label": "Discord",
          "docsPath": "/channels/discord"
        }
      ]
    }
  },
  "contributions": [
    {
      "id": "discord.adapter",
      "kind": "adapter.runtime",
      "title": "Discord messaging adapter"
    }
  ]
}
```

## Required Top-Level Fields

- `id`
  Stable extension package id. Never reused for a different extension.
- `name`
  Human-facing name for operator surfaces.
- `version`
  Extension package version.
- `apiVersion`
  Extension-host contract version the package was built against.
- `entry`
  Entry module the host activates.
- `distribution`
  Static metadata for install, onboarding, config, status, and lightweight operator UX. The block may be empty, but the field family is part of the source-of-truth shape.
- `contributions`
  List of contribution descriptors emitted by the extension.

## Recommended Top-Level Fields

- `description`
- `bundled`
- `permissionMode`
- `tags`
- `dependencies`
- `permissions`
- `config.schema`
- `config.uiHints`
- `distribution`
- `docs`
- `homepage`
- `support`

`bundled` is host metadata only. The kernel must never receive or depend on it.

Implementation rule:

- `distribution`, config metadata, and package metadata must be parseable without activating the extension entry module

## Permission Semantics

`permissions` describe requested host-managed powers and operator risk.

They do not automatically imply a hard runtime sandbox.

Recommended top-level field:

- `permissionMode`
  - `advisory`
  - `host-enforced`
  - `sandbox-enforced`

For the first extension-host cut, the default is `advisory` because extensions still run as trusted in-process code.

## Contribution Descriptor

Every contribution descriptor must contain:

- `id`
  Stable within the extension. The host resolves the runtime id as `<extension-id>/<contribution-id>`.
- `kind`
  Contribution family.
- `title`
  Human-facing label.

Recommended common fields:

- `description`
- `aliases`
- `tags`
- `enabledByDefault`
- `scope`
- `arbitration`
- `dependsOn`
- `permissions`
- `visibility`
- `capabilities`
- `selectors`
- `priority`
- `policy`

## Common Contribution Fields

### `scope`

Describes where the contribution is valid.

Supported scope fields:

- `global`
- `workspace`
- `agent`
- `account`
- `channel`
- `conversation`
- `provider`

Examples:

- a Slack adapter contribution is typically scoped by `account` and `channel`
- a memory backend is usually `workspace` or `agent`
- a provider integration contribution is scoped by `provider`

### `arbitration`

Declares how the host and kernel should treat overlapping providers.

Supported modes:

- `exclusive`
- `ranked`
- `parallel`
- `composed`

Supported attributes:

- `mode`
- `defaultRank`
- `singletonSlot`
- `selectionKey`
- `composeOrder`

### `visibility`

Declares whether the contribution is visible to:

- agents
- operators
- both
- neither

This matters because many contributions are runtime-only and must never appear in the agent tool catalog.

### `policy`

Declares host-managed policy gates that are more specific than broad permissions.

Examples:

- prompt mutation allowed, constrained, or denied
- fail-open versus fail-closed routing behavior
- whether a contribution may run on sync transcript hot paths

Decision for the first foundation cut:

```ts
type ContributionPolicy = {
  promptMutation?: "none" | "append-only" | "replace-allowed";
  routeEffect?: "observe-only" | "augment" | "veto" | "resolve";
  failureMode?: "fail-open" | "fail-closed";
  executionMode?: "parallel" | "sequential" | "sync-sequential";
};
```

These fields should be typed, not left as arbitrary metadata.

First-cut rule:

- keep `policy` limited to parity-driving behaviors unless the pilot migrations prove a broader typed model is necessary

### `dependsOn`

Contribution-level dependencies.

Supported dependency types:

- `requires`
- `optional`
- `conflicts`
- `supersedes`

Dependencies reference contribution ids, not package names, because runtime behavior is contribution-driven.

## Contribution Families

### Kernel-facing families

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

### Host-managed families

- `service.background`
- `surface.cli`
- `surface.config`
- `surface.status`
- `surface.setup`
- `surface.http-route`

## Family Contracts

### `adapter.runtime`

Used for messaging transports and any ingress or egress runtime.

Required runtime contract:

- `startAccount(accountRef)`
- `stopAccount(accountRef)`
- `decodeIngress(rawEvent)`
- `send(outboundEnvelope)`
- `health()`

Optional runtime contract:

- `handleAction(actionRef, payload)`
- `edit(outboundEnvelope)`
- `delete(targetRef)`
- `react(targetRef, reaction)`
- `poll(targetRef, pollPayload)`
- `fetchThread(threadRef)`
- `fetchMessage(messageRef)`
- `resolveDirectory(query)`
- `openConversation(target)`

Required descriptor metadata:

- supported conversation kinds
- identity scheme
- account binding model
- supported message action set
- supported interaction classes
- whether the adapter supports edits, deletes, reactions, polls, threads, buttons, cards, modals, moderation, or admin actions
- lightweight dock metadata for shared code paths that must not load the heavy runtime
- optional shared UX descriptors for typing, delivery feedback, reply context, history hints, and streaming behavior
- optional reload descriptors for config-driven hot-restart or no-op behavior
- optional gateway feature descriptors for method advertisement or transport-owned control surfaces

Important distinction:

- callable gateway or runtime methods belong in `capability.rpc`
- adapter-level gateway feature descriptors are metadata only
- those descriptors may advertise compatibility features, native transport affordances, or transport-owned control surfaces during migration, but they do not define a second callable RPC surface

The dock metadata is host-only. It is the normalized replacement for the current lightweight channel dock behavior in `src/channels/dock.ts:228`.

The lightweight dock contract should be specific enough to preserve current host-shared behavior from `main`, including:

- command gating hints
- allow-from formatting and default-target helpers
- threading defaults and reply-context helpers
- elevated allow-from fallback behavior
- agent prompt hints such as `messageToolHints`

### `capability.agent-tool`

Represents an agent-visible action.

This is the correct family for extension-backed search when the search surface is directly exposed to the agent, for example a canonical `web.search` or workspace-search action.

Required descriptor metadata:

- canonical action id
- planner-visible name
- input schema
- output schema or result contract
- visibility rules
- targeting requirements

### `capability.control-command`

Represents operator-facing commands that bypass the agent.

Examples today:

- `extensions/phone-control/index.ts:330`
- current plugin command registrations routed through `src/extension-host/command-runtime.ts:1` with `src/plugins/commands.ts:1` kept as the compatibility facade

Required descriptor metadata:

- command name
- description
- auth requirement
- surface availability
- whether the command accepts arguments
- optional provider-specific native command names for native slash or menu surfaces

Behavior rule:

- if a command does not accept arguments and arguments are supplied, the host should treat that invocation as a non-match and allow normal built-in or agent handling to continue

This preserves current behavior in `src/extension-host/command-runtime.ts:127`.

These are not agent tools.

### `capability.provider-integration`

Represents provider discovery, setup, auth, and post-selection lifecycle for model providers.

Required descriptor metadata:

- provider id
- auth method ids
- auth kinds
- discovery order
- wizard or onboarding metadata
- credential outputs
- optional config patch outputs
- optional refresh contract
- optional model-selected lifecycle hooks

This family exists because today's provider plugin contract includes more than auth, as shown in `src/plugins/types.ts:158`.

Scope rule:

- this family is specifically for chat or model-provider discovery, setup, auth, and post-selection lifecycle
- agent-visible search should not be folded into this family only because it may call remote providers under the hood
- non-chat subsystem providers such as embeddings, transcription, image understanding, video understanding, and TTS should not be folded into this family only because they also use remote providers
- those subsystem runtimes should use typed runtime contributions registered in host-owned runtime registries, usually under `capability.runtime-backend` with subsystem-specific capability metadata

### `capability.memory`

Represents a memory store or memory query runtime.

Required descriptor metadata:

- store kind
- supported query modes
- write policy
- default arbitration mode

### `capability.context-engine`

Represents a context-engine factory selected through an exclusive slot.

Required descriptor metadata:

- engine id
- singleton slot id
- factory contract
- default rank
- config selector key

### `capability.context-augmenter`

Represents a contribution that enriches prompt, tool, or session context without taking routing ownership.

Examples today:

- `extensions/diffs/index.ts:38`
- auto-recall style prompt/context contributions in `extensions/memory-lancedb/index.ts:548`

Recommended policy metadata:

- `promptMutation`
  - `none`
  - `append-only`
  - `replace-allowed`

This preserves behavior currently gated by `plugins.entries.<id>.hooks.allowPromptInjection`.

### `capability.event-handler`

Represents observers or side-effect handlers on canonical kernel events.

This family cannot mutate routing or veto delivery unless it is explicitly declared as `capability.route-augmenter`.

Required descriptor metadata:

- target event families
- handler class
- execution mode
- optional bridge source when the contribution originates from legacy hook or event systems

### `capability.route-augmenter`

Represents runtime handlers that can influence routing, binding, or egress decisions.

Examples today:

- send veto behavior in `extensions/thread-ownership/index.ts:63`
- subagent delivery target selection in `extensions/discord/src/subagent-hooks.ts:103`

Required descriptor metadata:

- allowed decision classes
- target event families
- fail-open or fail-closed behavior
- whether the handler must run on a sync hot path

Additional first-cut cases that should be modeled here:

- ingress claim or bound-route ownership decisions
- explicit conversation binding requests or detaches
- send veto decisions

Additional metadata when binding or ingress claim is involved:

- binding mode (`claim-only`, `bind`, `detach`, or `mixed`)
- whether operator approval is required before a bind can take effect
- persistence mode for approved or detached bindings
- restore-on-restart behavior
- whether the handler is allowed to short-circuit downstream command or agent dispatch

Important migration rule:

- do not preserve `inbound_claim` as a permanent plugin-era hook name in the final model
- bridge it during migration if needed, but normalize it into canonical ingress-stage route-augmentation behavior

### `capability.interaction`

Represents canonical interaction handlers such as slash commands, buttons, form submissions, or modal actions.

Required descriptor metadata:

- interaction namespace or routing key
- supported interaction classes
- supported channels or adapter families
- dedupe class or id strategy when callbacks may be retried
- fallback policy when no handler claims the interaction
- whether the handler may request conversation binding or detachment

First-cut constraint:

- the first interactive runtime cut should be validated on Telegram and Discord if they remain the highest-priority channels for parity
- that is rollout order only; the contract itself must stay generic, host-owned, and kernel-agnostic rather than becoming Telegram- or Discord-specific handler APIs

Ownership rule:

- extensions may own interaction logic and channel-specific rendering details
- the host owns namespace registration, dedupe, callback routing, approval persistence, and binding policy

Terminology clarification:

- plugin-specific behavior lives in the extension package
- transport-specific runtime behavior lives in that extension's `adapter.runtime` contribution
- the kernel only consumes generic contracts and must not learn Telegram-, Discord-, or plugin-specific behavior directly

### `capability.rpc`

Represents internal callable methods that are not agent tools.

Examples today:

- voice-call gateway methods in `extensions/voice-call/index.ts:230`

This family is the only place callable gateway-style methods should live.

If an adapter or transport wants to advertise that such methods exist, it may do so through metadata only, but the callable contract itself still belongs to `capability.rpc`.

### `capability.runtime-backend`

Represents a backend runtime provider used by another subsystem rather than directly by the agent.

ACP is the reference example:

- `extensions/acpx/src/service.ts:55`
- `src/acp/runtime/registry.ts:4`

Required descriptor metadata:

- backend class id
- selector key
- health probe contract
- default selection rank
- exclusivity or parallelism policy

This family exists because not all runtime providers are user-facing adapters.

This family is also the right home for plugin-provided subsystem runtimes when the runtime is consumed by a host or subsystem rather than directly by the agent.

Examples to support during migration:

- embeddings
- audio transcription
- image understanding
- video understanding
- text-to-speech
- search backends only when they are runtime-internal and not directly exposed as agent tools

Required metadata for these subsystem runtimes:

- subsystem id such as `embedding`, `media.audio`, `media.image`, `media.video`, or `tts`
- supported capability list
- typed request envelope contract
- provider-id normalization rules
- fallback policy
- override policy when a built-in implementation already exists

Retained behavior requirements:

- capability-based routing is worth keeping
- typed host-injected request fields such as `apiKey`, `baseUrl`, `headers`, `timeoutMs`, and `fetchFn` are worth keeping
- graceful fallback to built-in implementations is worth keeping

Important rule:

- keep these inside host-owned runtime registries for typed backend families
- do not widen `registerProvider(...)` into the permanent universal surface for every runtime subsystem
- if search is directly agent-visible, model it as `capability.agent-tool` instead of treating it as a generic provider family

### Adapter-runtime helper contracts

Some interactive and bound-conversation extensions need a bounded set of runtime helper contracts from the active adapter.

Examples of first-cut helpers:

- typing leases
- message edit or delete
- component or reply-markup updates
- pin or unpin
- thread or topic rename when already supported by the adapter

Important rule:

- these helpers should be modeled as adapter-runtime contracts or host-injected capabilities
- they should not be frozen into permanent Telegram- or Discord-shaped kernel APIs

### `service.background`

Represents long-running extension-managed processes owned by the host.

Examples today:

- `extensions/acpx/index.ts:10`
- `extensions/voice-call/index.ts:510`
- `extensions/diagnostics-otel/index.ts:10`

Required descriptor metadata:

- state scope
- desired state subdirectory
- startup ordering
- optional health contract

### `surface.http-route`

Represents host-managed HTTP or webhook surfaces.

Examples today:

- `extensions/diffs/index.ts:28`
- current plugin route registration in `src/plugins/http-registry.ts:12`

Required descriptor metadata:

- path
- auth mode
- match mode
- route owner id
- route class
- lifecycle mode (`static` or `dynamic`)
- scope metadata for account- or workspace-scoped routes

### `surface.config`, `surface.status`, `surface.setup`, `surface.cli`

These are operator surfaces, not kernel runtime behavior.

They must remain host-managed.

#### `surface.config`

Represents extension-provided config schema and config UI metadata consumed by host config APIs and operator UIs.

Required descriptor metadata:

- config schema
- UI hints
- sensitivity metadata for secret-bearing fields
- redaction and restoration compatibility requirements for round-tripping edited config

Important rule:

- `uiHints.sensitive` is not cosmetic metadata only
- the host must preserve current redaction and restore semantics used by config read and write flows, as in `src/gateway/server-methods/config.ts:151` and `src/config/redact-snapshot.ts:349`

#### `surface.cli`

Represents local operator CLI commands and subcommands registered under host-owned command trees.

Supported use cases:

- standalone diagnostic or admin commands
- install or update helpers
- provider-specific local operator commands
- entrypoints into interactive setup flows

Required descriptor metadata:

- command path or command id
- short description
- invocation mode (`standalone`, `subcommand`, or `flow-entry`)
- whether the command is interactive, non-interactive, or both

#### `surface.setup`

Represents host-managed setup and onboarding flows owned by an extension.

Supported use cases:

- interactive onboarding wizards
- non-interactive setup for automation or CI
- provider auth and configuration flows
- channel onboarding and account setup

Required descriptor metadata:

- flow id
- target surface (`cli`, `status`, `setup-ui`, or similar host surface)
- supported modes (`interactive`, `non-interactive`, or both)
- typed outputs such as config patches, credential results, install requests, status notes, or follow-up actions
- optional status phase for setup discovery and quickstart ranking
- optional reconfigure or already-configured flow
- optional disable flow
- optional DM policy prompts or policy patch outputs
- optional account-recording callback outputs for host-owned persistence

Ownership rule:

- extensions may own the flow logic
- the host owns prompting, persistence, credential writes, and command-tree integration

The setup contract should be able to represent the current onboarding adapter phases in `src/channels/plugins/onboarding-types.ts:59`, including:

- `getStatus`
- `configure`
- `configureInteractive`
- `configureWhenConfigured`
- `disable`

Recommended status metadata:

- whether the target is configured
- status lines
- optional selection hint
- optional quickstart score

## Static Distribution Metadata

Current `main` still relies on package metadata and lightweight descriptors outside the runtime contribution graph.

Examples:

- install entries in `src/plugins/install.ts:48`
- channel catalog metadata in `src/channels/plugins/catalog.ts:26`
- onboarding/status fallbacks in `src/commands/onboard-channels.ts:117`
- lightweight docks in `src/channels/dock.ts:228`

The host should therefore parse a separate static metadata block.

Recommended shape:

```ts
type DistributionMetadata = {
  install?: {
    entries?: string[];
    npmSpec?: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
  catalog?: {
    channels?: Array<{
      id: string;
      label: string;
      selectionLabel?: string;
      detailLabel?: string;
      docsPath?: string;
      docsLabel?: string;
      blurb?: string;
      order?: number;
      aliases?: string[];
      preferOver?: string[];
      systemImage?: string;
      selectionDocsPrefix?: string;
      selectionDocsOmitLabel?: boolean;
      selectionExtras?: string[];
      showConfigured?: boolean;
      quickstartAllowFrom?: boolean;
      forceAccountBinding?: boolean;
      preferSessionLookupForAnnounceTarget?: boolean;
    }>;
  };
  docks?: Array<{
    adapterId: string;
    capabilities: string[];
    metadata: Record<string, unknown>;
  }>;
};
```

These descriptors are host-only and may be read before runtime activation.

The catalog shape should preserve current host-visible channel metadata from `src/plugins/manifest.ts:121` and `src/channels/plugins/catalog.ts:117`, rather than collapsing it into a smaller generic shape.

Performance requirement:

- the host must be able to parse static distribution metadata without instantiating the heavy runtime entry module

## Resolved Extension And Contribution Objects

The host should normalize each package into one `ResolvedExtension` object, then derive static and runtime registries from it.

Recommended shape:

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
    install?: DistributionMetadata["install"];
    catalog?: DistributionMetadata["catalog"];
    docks?: DistributionMetadata["docks"];
    docs?: Record<string, unknown>;
    setup?: Array<Record<string, unknown>>;
    config?: {
      schema?: Record<string, unknown>;
      uiHints?: Record<string, unknown>;
    };
  };
  runtime: {
    contributions: ResolvedContribution[];
    services: Array<Record<string, unknown>>;
    routes: Array<Record<string, unknown>>;
    policies: Array<Record<string, unknown>>;
    stateOwnership: Record<string, unknown>;
  };
};
```

After validation, the host produces resolved contribution objects with normalized ids and runtime metadata.

Recommended shape:

```ts
type ResolvedContribution = {
  runtimeId: string;
  extensionId: string;
  contributionId: string;
  kind: string;
  title: string;
  description?: string;
  arbitration: ArbitrationDescriptor;
  scope: ScopeDescriptor;
  permissions: string[];
  dependencies: ResolvedDependencyGraph;
  visibility: VisibilityDescriptor;
  permissionMode: "advisory" | "host-enforced" | "sandbox-enforced";
  runtime: unknown;
  metadata: Record<string, unknown>;
};
```

The kernel only receives resolved contribution objects.

## Naming Rules

- extension ids are globally unique
- contribution ids are unique within an extension
- runtime ids are globally unique
- agent-visible names are not assumed unique and must be checked by the host
- aliases are advisory only; they never override canonical ids

Canonical action ids are open, namespaced strings, but core action families should be maintained in one reviewed source-of-truth registry.

Plugins may introduce new actions only by:

- reusing an existing canonical family
- or adding a newly reviewed canonical action id through the host or kernel registry update process

Plugins must not define new arbitration semantics outside the core schema.

## Migration Mapping From Today

- `registerChannel(...)` becomes one or more `adapter.runtime` contributions plus host surfaces
- `registerProvider(...)` becomes `capability.provider-integration`
- `registerTool(...)` becomes `capability.agent-tool`
- `registerCommand(...)` becomes `capability.control-command`
- `on(...)` becomes either `capability.event-handler`, `capability.context-augmenter`, or `capability.route-augmenter`
- `registerGatewayMethod(...)` becomes `capability.rpc`
- ACP backend registration becomes `capability.runtime-backend`
- `registerContextEngine(...)` becomes `capability.context-engine`
- `registerService(...)` becomes `service.background`
- `registerHttpRoute(...)` becomes `surface.http-route`
- package install and channel metadata become host-owned static distribution descriptors
- `configSchema` and `uiHints` become `surface.config`

Legacy runtime compatibility namespaces should also map intentionally into the new SDK instead of being carried forward wholesale.

Recommended module mapping:

- legacy `channelRuntime.text` -> SDK text and formatting helpers
- legacy `channelRuntime.reply` -> SDK reply dispatch and envelope helpers
- legacy `channelRuntime.routing` -> SDK route resolution helpers
- legacy `channelRuntime.pairing` -> SDK pairing helpers
- legacy `channelRuntime.media` -> SDK media helpers
- legacy `channelRuntime.activity` and `channelRuntime.session` -> SDK session and activity helpers
- legacy `channelRuntime.mentions`, `groups`, and `commands` -> SDK shared channel-policy helpers
- legacy `channelRuntime.debounce` -> SDK inbound debounce helpers
- provider-specific runtime namespaces should become provider-scoped compatibility shims only, not long-term core SDK modules

## Immediate Implementation Work

1. Add a new manifest parser in the extension host rather than extending `src/plugins/manifest.ts:11`.
2. Define TypeScript source-of-truth types for `ResolvedExtension`, `ResolvedContribution`, and `ContributionPolicy`.
3. Create validators for top-level manifest fields and per-family descriptors.
4. Add static distribution and package metadata parsers for install, onboarding, config, status, and dock descriptors.
5. Preserve minimal SDK compatibility loading while the new schema is introduced.
6. Build a compatibility translator from current plugin registrations into contribution descriptors.
7. Keep the legacy manifest as an input format only during migration.
8. Record parity gaps discovered while migrating `thread-ownership` first.
9. Record parity gaps discovered while migrating `telegram` second.
