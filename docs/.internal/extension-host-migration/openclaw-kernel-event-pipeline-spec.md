Temporary internal migration note: remove this document once the extension-host migration is complete.

# OpenClaw Kernel Event Pipeline Spec

Date: 2026-03-15

## Purpose

This document defines the canonical kernel event model, execution stages, handler classes, ordering, mutation rules, and veto semantics.

The goal is to replace today's mixed plugin hook behavior with one explicit runtime pipeline and a small set of execution modes that match current `main` behavior.

## TODOs

- [ ] Implement canonical event types and stage ordering in code.
- [ ] Bridge current plugin hooks, internal hooks, and agent event streams into the pipeline.
- [ ] Implement sync transcript-write stages with parity for current hot paths.
- [ ] Record the legacy-to-canonical mapping table used by the first pilot migrations.
- [ ] Record parity for `thread-ownership` first and `telegram` second before broader event migration.
- [ ] Document which legacy hook sources are still bridged and which have been retired.
- [ ] Add parity tests for veto, resolver, and sync-stage behavior.

## Implementation Status

Current status against this spec:

- no canonical event pipeline work has landed yet
- only the prerequisites from earlier phases are underway

Relevant prerequisite work that has landed:

- an initial Phase 0 cutover inventory now exists in `src/extension-host/cutover-inventory.md`
- the extension-host boundary now owns active registry state
- registry activation now routes through `src/extension-host/activation.ts`
- initial normalized extension schema types now exist
- static consumers can now read host-owned resolved-extension data
- config doc baseline generation now uses the same host-owned resolved-extension data path
- channel, provider, HTTP-route, gateway-method, tool, CLI, service, command, context-engine, and hook registration normalization now has a host-owned helper boundary
- loader cache key construction and registry cache control now have a host-owned helper boundary
- loader provenance helpers now have a host-owned helper boundary
- loader duplicate-order policy now has a host-owned helper boundary
- loader alias-wired module loader creation now has a host-owned helper boundary
- loader lazy runtime proxy creation now has a host-owned helper boundary
- loader initial candidate planning and record creation now have a host-owned helper boundary
- loader entry-path opening and module import now have a host-owned helper boundary
- loader module-export resolution, config validation, and memory-slot load decisions now have a host-owned helper boundary
- loader post-import planning and `register(...)` execution now have a host-owned helper boundary
- loader per-candidate orchestration now has a host-owned helper boundary
- loader top-level load orchestration now has a host-owned helper boundary
- loader host process state now has a host-owned helper boundary
- loader preflight and cache-hit setup now has a host-owned helper boundary
- loader post-preflight pipeline composition now has a host-owned helper boundary
- loader execution setup composition now has a host-owned helper boundary
- loader discovery and manifest bootstrap now has a host-owned helper boundary
- loader discovery policy outcomes now have a host-owned helper boundary
- loader mutable activation state now has a host-owned helper boundary
- loader session run and finalization composition now has a host-owned helper boundary
- loader activation policy outcomes now have a host-owned helper boundary
- loader record-state transitions now have a host-owned helper boundary and enforced loader lifecycle state machine, while still preserving compatibility `PluginRecord.status` values
- loader finalization policy outcomes now have a host-owned helper boundary
- loader final cache, readiness promotion, and activation finalization now has a host-owned helper boundary
- low-risk channel, provider, gateway-method, HTTP-route, tool, CLI, service, command, context-engine, and hook compatibility writes now have a host-owned helper boundary in `src/extension-host/registry-writes.ts`
- legacy internal-hook bridging and typed prompt-injection compatibility policy now have a host-owned helper boundary in `src/extension-host/hook-compat.ts`
- compatibility `OpenClawPluginApi` composition and logger shaping now have a host-owned helper boundary in `src/extension-host/plugin-api.ts`
- compatibility plugin-registry facade ownership now has a host-owned helper boundary in `src/extension-host/plugin-registry.ts`
- compatibility plugin-registry policy now has a host-owned helper boundary in `src/extension-host/plugin-registry-compat.ts`
- compatibility plugin-registry registration actions now have a host-owned helper boundary in `src/extension-host/plugin-registry-registrations.ts`
- host-owned runtime registry accessors now have a host-owned helper boundary in `src/extension-host/runtime-registry.ts`, and the channel, provider, tool, HTTP-route, gateway-method, CLI, and service slices now keep host-owned storage there with mirrored legacy compatibility views
- service startup, stop ordering, service-context creation, and failure logging now have a host-owned helper boundary in `src/extension-host/service-lifecycle.ts`
- CLI duplicate detection, registrar invocation, and async failure logging now have a host-owned helper boundary in `src/extension-host/cli-lifecycle.ts`
- gateway method-id aggregation, plugin diagnostic shaping, and extra-handler composition now have a host-owned helper boundary in `src/extension-host/gateway-methods.ts`
- plugin tool resolution, conflict handling, optional-tool gating, and plugin-tool metadata tracking now have a host-owned helper boundary in `src/extension-host/tool-runtime.ts`
- plugin provider projection from registry entries into runtime provider objects now have a host-owned helper boundary in `src/extension-host/provider-runtime.ts`
- plugin provider discovery filtering, order grouping, and result normalization now have a host-owned helper boundary in `src/extension-host/provider-discovery.ts`
- provider matching, auth-method selection, config-patch merging, and default-model application now have a host-owned helper boundary in `src/extension-host/provider-auth.ts`
- provider onboarding option building, model-picker entry building, and provider-method choice resolution now have a host-owned helper boundary in `src/extension-host/provider-wizard.ts`
- loaded-provider auth application, plugin-enable gating, auth-method execution, and post-auth default-model handling now have a host-owned helper boundary in `src/extension-host/provider-auth-flow.ts`
- provider post-selection hook lookup and invocation now have a host-owned helper boundary in `src/extension-host/provider-model-selection.ts`

Why this matters for this spec:

- event work should land on top of a host-owned boundary and normalized contribution model rather than on top of more plugin-era runtime seams
- the current implementation has deliberately not started canonical bridge or stage work before those earlier boundaries were in place, including the first loader-runtime, record-state, discovery-policy, activation-policy, finalization-policy, low-risk registry-write, hook-compat, plugin-api, plugin-registry, plugin-registry-compat, plugin-registry-registrations, runtime-registry storage and accessors, service-lifecycle, CLI-lifecycle, gateway-methods, tool-runtime, provider-runtime, provider-discovery, provider-auth, provider-wizard, provider-auth-flow, and provider-model-selection seams

## Design Goals

- every inbound and outbound path goes through one canonical pipeline
- handler behavior is declared, not inferred
- routing-affecting handlers are distinct from passive observers
- ordering and merge rules are deterministic
- extension failures are isolated and visible
- sync transcript-write paths remain explicit rather than being hidden inside generic async stages
- current plugin hooks, internal hooks, and agent event streams can be bridged into one model incrementally
- the migration path for legacy event buses is explicit rather than accidental

## Sequencing Constraints

This pipeline is a migration target, not a prerequisite for every other host change.

Therefore:

- minimal SDK compatibility and host registry ownership should land before broad hook migration
- the first event migration should prove parity for a small non-channel hook case and a channel case
- do not require every event family to be implemented before pilot migrations can bridge the current hook set
- do not leave legacy hook buses as undocumented permanent peers to the canonical pipeline

## Canonical Event Families

The kernel should emit typed event families instead of raw plugin hook names.

Recommended families:

- `runtime.started`
- `runtime.stopping`
- `gateway.starting`
- `gateway.started`
- `gateway.stopping`
- `command.received`
- `command.completed`
- `account.started`
- `account.stopped`
- `ingress.received`
- `ingress.normalized`
- `ingress.claiming`
- `routing.resolving`
- `routing.resolved`
- `session.starting`
- `session.started`
- `session.resetting`
- `agent.starting`
- `agent.model.resolving`
- `agent.prompt.building`
- `agent.llm.input`
- `agent.llm.output`
- `agent.tool.calling`
- `agent.tool.called`
- `transcript.tool-result.persisting`
- `transcript.message.writing`
- `compaction.before`
- `compaction.after`
- `agent.completed`
- `egress.preparing`
- `egress.sending`
- `egress.sent`
- `egress.cancelled`
- `egress.failed`
- `interaction.received`
- `subagent.spawning`
- `subagent.spawned`
- `subagent.delivery.resolving`
- `subagent.delivery.resolved`
- `subagent.completed`

These families intentionally cover the behavior currently spread across `src/plugins/hooks.ts:1`, `src/hooks/internal-hooks.ts:13`, `src/infra/agent-events.ts:3`, and channel monitors.

`ingress.claiming` exists to absorb behavior that is currently tempting to model as plugin-specific hooks or direct dispatch short-circuits:

- bound conversation ownership
- first-claim-wins plugin or extension routing
- future route-claim or veto decisions that must run before command or agent dispatch

## Canonical Event Envelope

Every event should carry:

- `eventId`
- `family`
- `occurredAt`
- `workspaceId`
- `agentId`
- `sessionId`
- `accountRef`
- `conversationRef`
- `threadRef`
- `messageRef`
- `sourceContributionId`
- `correlationId`
- `payload`
- `metadata`
- `providerMetadata`
- `hotPath`

The event envelope is immutable. Mutation happens through stage outputs, not by mutating the event object in place.

## Handler Classes

Each handler contribution must declare exactly one class:

- `observer`
- `augmenter`
- `mutator`
- `veto`
- `resolver`

### `observer`

Side effects only. No runtime decision output.

### `augmenter`

May attach additional context for downstream stages.

Examples:

- prompt context injection
- memory recall summaries
- diagnostics enrichment

### `mutator`

May modify a typed working object for the current pipeline stage.

Examples:

- prompt build additions
- model override
- tool call decoration

### `veto`

May cancel a downstream action with a typed reason.

Examples today:

- send cancellation in `extensions/thread-ownership/index.ts:63`

### `resolver`

May produce a selected target or route decision.

Examples today:

- subagent delivery target selection in `extensions/discord/src/subagent-hooks.ts:103`

Only `veto` and `resolver` handlers may influence routing or delivery decisions.

`ingress.claiming` is the first concrete place where a resolver-like route claim is expected to matter during migration.

First-cut parity rule for `ingress.claiming`:

- claim handlers run sequentially in deterministic order
- the first successful claim wins ownership of the inbound turn
- passive observers still run in their own stages instead of being skipped accidentally
- the migration bridge may target a single extension when a host-owned binding already resolved the owner

## Execution Modes

The semantic handler class is not enough by itself.

Each stage must also declare one of three execution modes:

- `parallel`
  For read-only observers and low-risk side effects.
- `sequential`
  For merge, mutation, veto, and resolver stages.
- `sync-sequential`
  For transcript and persistence hot paths where async handlers are not allowed.

This mirrors current `main` behavior in `src/plugins/hooks.ts:199`, `src/plugins/hooks.ts:226`, `src/plugins/hooks.ts:465`, and `src/plugins/hooks.ts:528`.

## Deterministic Ordering

Within a stage, handlers run in this order:

1. explicit priority descending
2. extension id ascending
3. contribution id ascending

Priority is optional. Ties must resolve deterministically.

## Stage Execution Model

Every pipeline stage declares:

- which handler classes are allowed
- execution mode
- whether handlers run in parallel or sequentially
- how outputs are merged
- whether errors fail open or fail closed

## Gateway And Command Pipeline

### Stage: `gateway.starting`, `gateway.started`, `gateway.stopping`

Allowed handler classes:

- `observer`

Execution mode:

- `parallel`

Purpose:

- lifecycle telemetry
- startup and shutdown side effects

### Stage: `command.received`, `command.completed`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- command audit
- command lifecycle integration
- operator-visible side effects
- preserve source-surface metadata for chat commands, native commands, and host CLI invocations when those flows are bridged into canonical command events

Bridge requirement:

- the current internal hook bus in `src/hooks/internal-hooks.ts:13`
- and the current agent event stream in `src/infra/agent-events.ts:3`

must be mapped deliberately into canonical families during migration.

Acceptable end states are:

- they become compatibility sources that emit canonical events
- or they are fully retired after parity is reached

An undocumented permanent fourth event system is not acceptable.

## Ingress Pipeline

### Stage 1: `ingress.received`

Input:

- raw adapter payload

Allowed handler classes:

- `observer`

Execution mode:

- `parallel`

Purpose:

- telemetry
- raw audit
- diagnostics

### Stage 2: `ingress.normalized`

Input:

- normalized inbound envelope from `adapter.runtime.decodeIngress`

Allowed handler classes:

- `observer`
- `augmenter`
- `mutator`

Execution mode:

- `sequential`

Purpose:

- add normalized metadata
- enrich source/account context
- attach pre-routing annotations

This stage must not choose a route.

### Stage 3: `routing.resolving`

Allowed handler classes:

- `augmenter`
- `resolver`
- `veto`

Execution mode:

- `sequential`

Purpose:

- route lookup
- ownership checks
- subagent delivery target resolution
- policy application before route finalization

Merge rules:

- `resolver` outputs produce candidate route decisions
- highest-precedence valid decision wins
- `veto` may cancel route selection

### Stage 4: `routing.resolved`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- emit resolved route metadata
- enrich downstream session context

### Stage 5: `session.starting`

Allowed handler classes:

- `observer`
- `augmenter`
- `mutator`

Execution mode:

- `sequential`

Purpose:

- bind session context
- attach memory lookup keys
- prepare session-scoped metadata

### Stage 6: `session.started`

Allowed handler classes:

- `observer`

Execution mode:

- `parallel`

Purpose:

- fire lifecycle observers

### Stage 7: `agent.starting`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- last pre-run annotations

## Prompt And Model Pipeline

### Stage: `agent.model.resolving`

Allowed handler classes:

- `mutator`

Execution mode:

- `sequential`

Merge rules:

- first defined model override wins
- first defined provider override wins

This mirrors current precedence in `src/plugins/hooks.ts:117`.

### Stage: `agent.prompt.building`

Allowed handler classes:

- `augmenter`
- `mutator`

Execution mode:

- `sequential`

Merge rules:

- static system guidance composes in declared order
- ephemeral prompt additions compose in declared order
- direct system prompt replacement is allowed only for explicitly trusted mutators

This replaces the ambiguous overlap between `before_prompt_build` and legacy `before_agent_start` in `src/plugins/types.ts:422`.

### Stage: `agent.llm.input`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- provider-call audit
- input usage and prompt metadata capture

### Stage: `agent.llm.output`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- provider response audit
- usage capture
- output enrichment

## Tool Pipeline

### Stage: `agent.tool.calling`

Allowed handler classes:

- `observer`
- `augmenter`
- `mutator`
- `veto`

Execution mode:

- `sequential`

Purpose:

- tool policy checks
- argument normalization
- tool-call audit

### Stage: `agent.tool.called`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- result indexing
- memory capture
- diagnostics

### Stage: `agent.completed`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- end-of-run capture
- automatic memory storage
- metrics

## Persistence Pipeline

### Stage: `transcript.tool-result.persisting`

Allowed handler classes:

- `mutator`

Execution mode:

- `sync-sequential`

Purpose:

- mutate the tool-result message that will be appended to transcripts

Rules:

- async handlers are invalid
- handlers run in deterministic priority order
- each handler sees the previous handler's output

This is the explicit replacement for today's sync-only `tool_result_persist` hook in `src/plugins/hooks.ts:465`.

### Stage: `transcript.message.writing`

Allowed handler classes:

- `mutator`
- `veto`

Execution mode:

- `sync-sequential`

Purpose:

- final transcript message mutation
- transcript write suppression when explicitly requested

Rules:

- async handlers are invalid
- successful veto decisions are terminal
- mutation happens before the final write

This is the explicit replacement for today's sync-only `before_message_write` hook in `src/plugins/hooks.ts:528`.

## Compaction And Reset Pipeline

Canonical stages:

- `compaction.before`
- `compaction.after`
- `session.resetting`

## Egress Pipeline

### Stage 1: `egress.preparing`

Input:

- normalized outbound envelope

Allowed handler classes:

- `observer`
- `augmenter`
- `mutator`
- `veto`
- `resolver`

Execution mode:

- `sequential`

Purpose:

- choose provider or account when not explicit
- attach send metadata
- enforce ownership or safety policy

This stage replaces today’s mixed send hooks and route checks.

### Stage 2: `egress.sending`

Allowed handler classes:

- `observer`

Execution mode:

- `parallel`

Purpose:

- telemetry and audit before transport send

### Stage 3: `egress.sent`, `egress.cancelled`, `egress.failed`

Allowed handler classes:

- `observer`
- `augmenter`

Execution mode:

- `sequential`

Purpose:

- post-send side effects
- delivery-state indexing

## Interaction Pipeline

Interaction events should not be routed through message hooks.

Canonical stages:

- `interaction.received`
- `interaction.resolved`
- `interaction.completed`

These handle slash commands, button presses, modal submissions, and similar surfaces.

## Subagent Pipeline

The current hook set already proves this needs explicit treatment:

- `subagent_spawning`
- `subagent_delivery_target`
- `subagent_spawned`
- `subagent_ended`

The canonical form should be:

- `subagent.spawning`
- `subagent.spawned`
- `subagent.delivery.resolving`
- `subagent.delivery.resolved`
- `subagent.completed`

Resolver semantics:

- multiple candidates may be proposed
- explicit target beats inferred target
- otherwise highest-ranked valid candidate wins

## Merge Rules

### Observer

No merge output.

### Augmenter

Produces additive metadata only.

Conflicts merge by:

- key append for list-like fields
- last-writer-wins only for fields explicitly marked replaceable

### Mutator

Produces typed patch objects.

Rules:

- patch schema is stage-specific
- patches apply in deterministic order
- later patches see earlier outputs

### Veto

Produces:

- `allow`
- `cancel`

Rules:

- one `cancel` is terminal if the stage is fail-closed
- fail-open stages may ignore veto errors but not successful veto decisions

### Resolver

Produces candidate selections.

Rules:

- explicit target selectors win
- otherwise rank, policy, and deterministic tie-breakers apply

## Error Handling

Per-stage error policy must be explicit.

Recommended defaults:

- telemetry and observer stages fail open
- routing and send veto stages fail open unless the contribution declares `failClosed`
- credential or auth mutation stages fail closed
- backend selection stages fail closed when no valid provider remains
- sync transcript stages fail open on handler failure but must still reject accidental async handlers

## Legacy Hook Mapping

Current hook names map approximately like this:

- `before_model_resolve` -> `agent.model.resolving`
- `before_prompt_build` -> `agent.prompt.building`
- `before_agent_start` -> split between `agent.model.resolving` and `agent.prompt.building`
- `llm_input` -> `agent.llm.input`
- `llm_output` -> `agent.llm.output`
- `message_received` -> `ingress.normalized`
- `message_sending` -> `egress.preparing`
- `message_sent` -> `egress.sent`
- `before_tool_call` -> `agent.tool.calling`
- `after_tool_call` -> `agent.tool.called`
- `tool_result_persist` -> `transcript.tool-result.persisting`
- `before_message_write` -> `transcript.message.writing`
- `before_compaction` -> `compaction.before`
- `after_compaction` -> `compaction.after`
- `before_reset` -> `session.resetting`
- `gateway_start` -> `gateway.started`
- `gateway_stop` -> `gateway.stopping`
- `subagent_delivery_target` -> `subagent.delivery.resolving`

First pilot focus:

- `thread-ownership` should validate `message_received` and `message_sending` migration into canonical ingress and egress stages
- `telegram` should validate that channel-path runtime behavior can participate in canonical events without reintroducing plugin-shaped kernel seams

## Immediate Implementation Work

1. Add canonical event and stage types to the kernel.
2. Build a stage runner with explicit handler-class validation.
3. Add typed patch and veto result contracts per stage, including sync-sequential stages.
4. Bridge legacy plugin hooks, internal hooks, and agent events into canonical stages in the extension host only.
5. Record the exact legacy-to-canonical mapping used by `thread-ownership`.
6. Record the exact legacy-to-canonical mapping used by `telegram`.
7. Refactor one channel and one non-channel extension through the new pipeline before broader migration.
8. Decide and document the retirement plan for any legacy event bus that remains after parity is achieved.
