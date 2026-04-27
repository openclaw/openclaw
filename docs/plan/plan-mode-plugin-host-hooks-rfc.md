---
title: "Plan Mode Plugin Host Hooks RFC"
summary: "Maintainer RFC packet for the generic host hooks required to port Plan Mode into a first-class bundled plugin"
read_when:
  - Reviewing PR #71676 or a Plan Mode plugin port
  - Deciding which generic host hooks are needed before Plan Mode can leave core patches
  - Implementing plugin-owned session state, turn injections, tool policy, command continuation, Control UI slots, or scheduler lifecycle
---

## RFC Packet Status

Draft maintainer RFC packet.

<Warning>
  This document is a proposal and maintainer handoff, not implemented SDK
  reference. The named APIs are contract targets for a future host-hook PR and
  should not be documented as available until that implementation lands.
</Warning>

Primary behavior source:

- PR #71676, "Plan Mode rebased onto upstream/main + executing-state subsystem"

Primary implementation goal:

- Make PR #71676 shrinkable by moving Plan Mode behavior into a bundled plugin.
- Land one host-hook PR that adds generic, reusable OpenClaw plugin seams.
- Keep Plan Mode-specific behavior out of core.

This document is intentionally more detailed than a public user guide. It is a
maintainer handoff artifact for filing RFC issues, reviewing the host-hook PR,
and preventing a plugin port from silently dropping parity.

## Filed RFC Issues

| RFC | Issue                                                       | Decision thread                                                             |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| A   | [#71732](https://github.com/openclaw/openclaw/issues/71732) | Plugin session extensions and patch actions                                 |
| B   | [#71733](https://github.com/openclaw/openclaw/issues/71733) | Durable next-turn injections and agent turn preparation hooks               |
| C   | [#71734](https://github.com/openclaw/openclaw/issues/71734) | Trusted tool policy stage and plugin tool metadata                          |
| D   | [#71735](https://github.com/openclaw/openclaw/issues/71735) | Scoped plugin commands, trusted command ownership, and continuation         |
| E   | [#71736](https://github.com/openclaw/openclaw/issues/71736) | Control UI plugin contribution slots                                        |
| F   | [#71737](https://github.com/openclaw/openclaw/issues/71737) | Agent events, run context, scheduler lifecycle, and heartbeat contributions |

## Current SDK Research Baseline

This RFC packet is intentionally using
[#71427](https://github.com/openclaw/openclaw/issues/71427) as the review bar.
That issue was closed because current `main` already exposed hooks that owned
the requested tool-call and tool-result persistence lifecycle. For the six Plan
Mode RFCs, the test is therefore not "is there any nearby hook?" The test is:

- Does the existing SDK surface own the same lifecycle boundary?
- Does it expose the payload shape a plugin needs without patching host files?
- Does it provide host-owned ordering, authorization, disablement, and cleanup?
- Can a fixture plugin prove the behavior without Plan Mode-specific core code?

The current answer is mixed. OpenClaw has useful adjacent hooks, but none of
the six RFCs is fully resolved by the current plugin SDK.

| RFC                                                              | Existing current surface                                                                                                                                                                             | What it already covers                                                                                             | Why it does not resolve the RFC                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Plugin session extensions and patch actions                   | Fixed `SessionEntry`, fixed `sessions.patch`, hardcoded `GatewaySessionRow`, internal post-write `session:patch`, scoped plugin gateway RPCs.                                                        | Core can persist and patch known session fields; plugins can expose separate gateway methods with declared scopes. | There is no `api.registerSessionExtension(...)`, no namespaced persisted plugin session state, no gateway-routed plugin patch action, no public extension projection in session rows, and no host-owned reset/delete/compaction cleanup for plugin state.                  |
| B. Durable next-turn injections and turn preparation             | `before_prompt_build`, legacy `before_agent_start`, and in-memory system events can prepend context to a prompt.                                                                                     | Plugins can add current-turn prompt context.                                                                       | There is no durable `enqueueNextTurnInjection(...)`, no `agent_turn_prepare` boundary before retry/provider transforms, no exactly-once dequeue semantics, no persisted expiry/dedupe, and no disabled-plugin suppression for queued injections.                           |
| C. Trusted tool policy and tool metadata                         | `before_tool_call` can block, rewrite params, or require approval; core config filters tools before wrapping; plugin tools have basic catalog fields.                                                | Normal plugins can observe or block ordinary tool calls; plugin tools can appear in the catalog.                   | There is no trusted pre-plugin policy stage, no bundled-only policy registration, no guarantee a normal plugin cannot reorder around the gate, no plugin tool metadata/display registry, and no safe decoration path for core-owned tools such as `update_plan`.           |
| D. Scoped commands, ownership, and continuation                  | `api.registerCommand(...)` exists; command context includes `gatewayClientScopes`; plugin gateway methods can declare `opts.scope`; duplicate plugin command registrations are blocked.              | Plugins can register slash commands and self-inspect available scopes.                                             | Commands cannot declare `requiredScopes` for host enforcement, untrusted plugins cannot have a reviewed reserved-root ownership model, and plugin command handling always stops instead of returning `continueAgent` to resume an agent turn.                              |
| E. Control UI contribution slots                                 | Remote slash command discovery exists; generic plugin approval request/broadcast/card rendering exists; chat rendering and tool-card classification are host-coded.                                  | The UI can list plugin slash commands and can render a generic plugin approval card.                               | There is no `api.registerControlUiContribution(...)`, no chat mode descriptor projection, no input guard descriptor, no plugin event/status classifier registry, and no first-class data-driven UI slot for plugin-owned cards beyond the generic approval surface.        |
| F. Agent events, run context, scheduler, and heartbeat lifecycle | `runtime.events.onAgentEvent` exposes raw agent events; internal `AgentRunContext` exists; `gateway_start` can expose `getCron`; prompt hooks can affect normal prompts; heartbeat can be requested. | Plugins can observe broad runtime events, manually use low-level cron access, and add generic prompt context.      | There is no typed `api.onAgentEvent(...)` with filters and cleanup, no namespaced plugin run-context bag, no session-owned scheduler helper with plugin cleanup on reset/delete/disable, and no heartbeat-specific contribution hook or heartbeat-scoped turn preparation. |

Concrete existing-code anchors for the audit:

- Current hook names live in `src/plugins/hook-types.ts`; they include
  `before_prompt_build`, `before_tool_call`, `tool_result_persist`,
  `before_message_write`, `gateway_start`, and agent/subagent lifecycle hooks,
  but not `agent_turn_prepare` or `heartbeat_prompt_contribution`.
- Session patch validation is fixed in
  `src/gateway/protocol/schema/sessions.ts` and
  `src/gateway/server-methods/sessions.ts`; plugin-specific session patch
  fields are not accepted.
- Plugin command definitions in `src/plugins/types.ts` and execution in
  `src/plugins/commands.ts` support auth and handler context, but not
  declarative command scopes, reserved-root ownership, or agent continuation.
- Tool hooks in `src/plugins/hooks.ts` and
  `src/agents/pi-tools.before-tool-call.ts` provide normal plugin ordering, not
  a host-trusted pre-plugin policy tier.
- Control UI rendering in `ui/src/ui/views/chat.ts`,
  `ui/src/ui/app-tool-stream.ts`, and `ui/src/ui/chat/tool-cards.ts` is still
  hardcoded around known chat/tool/event shapes rather than projected plugin UI
  contribution descriptors.
- Agent events, run context, cron, and heartbeat behavior exist in
  `src/infra/agent-events.ts`, `src/cron/*`, and
  `src/infra/heartbeat-runner.ts`, but the current plugin SDK does not expose
  the requested typed lifecycle-owned helper surfaces.

## Reusable SDK Capability Matrix

Plan Mode is the pressure test because it currently costs roughly a large
feature PR worth of host edits. It should not be the only beneficiary. The hook
families below are SDK primitives that let other plugins become first-class
without copying the same host patches.

| RFC | SDK primitive                                                             | Public, bundled, or protocol surface                                                                                                    | Plan Mode proof case                                                                                      | Other plugin families enabled                                                                                                                                     |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Plugin session extensions and patch actions                               | Public SDK registration plus gateway protocol patch method/envelope. Patch actions may declare gateway scopes.                          | Store plan mode, approval status, question state, pending injection ids, and nudge job ids.               | Memory/context managers, deployment workflows, incident/ticket bots, budget governors, channel preference plugins, long-running job monitors.                     |
| B   | Durable next-turn injection queue and agent turn preparation              | Public enqueue API plus host-owned runner dequeue boundary. Turn hooks may be public; queue storage is host-owned.                      | Continue after approval, revise a plan, answer a question, inject scheduled nudges exactly once.          | CI triage follow-ups, code review bots, release handoff prompts, memory recall injectors, incident escalation prompts, customer-support workflow plugins.         |
| C   | Trusted tool policy and plugin tool metadata                              | Normal metadata is public; pre-plugin policy is bundled/trusted-only; tool display is a gateway/UI descriptor contract.                 | Block mutating tools while approval is pending and publish Plan Mode tool display/safety metadata.        | Cost/budget limiters, workspace policy plugins, dangerous action approval wrappers, deployment freeze gates, data egress guards, sandbox/tool visibility plugins. |
| D   | Scoped commands, trusted command ownership, and continuation              | Public command SDK for scopes/continuation; reserved roots require bundled/trusted manifest ownership.                                  | `/plan accept` patches state, enqueues continuation, and resumes the agent.                               | `/deploy approve`, `/review ship`, `/incident ack`, `/budget override`, `/memory pin`, `/ticket close`, and channel-specific command adapters.                    |
| E   | Control UI contribution descriptors                                       | Gateway projection plus data-only UI descriptor contract. Arbitrary plugin browser JavaScript is out of scope for the first version.    | Plan/Plan Auto modes, approval/question cards, composer guards, and status indicators without UI patches. | Release dashboards, budget warnings, incident banners, review gates, memory/context panels, channel-auth cards, human approval cards.                             |
| F   | Agent events, run context, session scheduler, and heartbeat contributions | Public typed event/scheduler helpers plus host-owned lifecycle cleanup. Some event categories may be bundled/trusted-only if sensitive. | Persist plan snapshots, track subagents, schedule nudges, and add heartbeat reminders.                    | Telemetry exporters, audit logs, SLA escalators, background sync plugins, recurring check-ins, CI/deploy monitors, memory indexers.                               |

## Plugin Archetype Matrix

These examples are intentionally not Plan Mode-specific. They show why the
proposed hooks belong in the OpenClaw SDK rather than in one bundled plugin.

| Plugin archetype           | Session extension                                           | Next-turn injection                                        | Tool policy and metadata                                                 | Scoped commands                                                         | UI contribution                                     | Events, scheduler, heartbeat                                        |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Human approval workflow    | Approval state, approver, deadline, decision history.       | Continue after approval or inject revision instructions.   | Block risky tools until approved; mark approval tools as state-mutating. | `/approve`, `/reject`, `/revise` with approval scopes and continuation. | Approval cards, pending banners, composer guards.   | Expire stale approvals and nudge approvers.                         |
| Deployment/release plugin  | Release candidate, environment, rollout phase, rollback id. | Inject release checklist or post-approval deploy command.  | Gate deploy/rollback tools during freeze windows.                        | `/deploy approve`, `/rollback`, `/release status`.                      | Release status panel and deploy approval card.      | Watch CI/deploy events, schedule smoke-test follow-ups.             |
| Cost/budget governor       | Per-session budget, model/tool spend, override state.       | Inject budget warning or downgrade guidance on next turn.  | Block expensive tools/models or require override approval.               | `/budget status`, `/budget override`.                                   | Budget meter, warning card, blocked-input hint.     | Heartbeat reminders when budget is near limit; export spend events. |
| Memory/context manager     | Pins, recall cursors, source visibility, compaction policy. | Inject selected memories/context once at turn start.       | Decorate memory tools with display/safety metadata.                      | `/memory pin`, `/memory forget`, `/context refresh`.                    | Context panel and memory-selection cards.           | Index agent events and schedule background refresh.                 |
| Code review/PR gate        | Review checklist, unresolved findings, approval state.      | Inject review summary or required fix list.                | Block merge/push/deploy tools until findings are resolved.               | `/review approve`, `/review request-changes`, `/review rerun`.          | Review gate card, status chips, finding summary.    | Watch test/review events and schedule bot rechecks.                 |
| Incident/ticket workflow   | Incident id, severity, owner, SLA, ticket sync cursor.      | Inject handoff, escalation, or ticket-update instructions. | Gate risky remediation tools behind incident role/scope.                 | `/incident ack`, `/incident escalate`, `/ticket close`.                 | Incident banner, SLA countdown, ticket action card. | Schedule escalations and export timeline events.                    |
| Channel integration plugin | Channel thread state, auth handoff, delivery preferences.   | Inject deferred replies or cross-channel follow-ups.       | Mark channel tools with delivery/safety metadata.                        | `/telegram approve`, `/slack handoff`, `/email summarize`.              | Auth cards, channel delivery status, input guards.  | Track delivery events and retry scheduled sends.                    |
| Workspace policy plugin    | Workspace rules, allowed paths, exception grants.           | Inject policy explanation or remediation steps.            | Block or require approval for policy-violating tools.                    | `/policy explain`, `/policy grant`, `/policy revoke`.                   | Policy warning card and blocked-action explanation. | Audit tool events and clear grants on session reset.                |
| Telemetry/export plugin    | Export cursor, sink status, redaction mode.                 | Rare; may inject diagnostic summary after failure.         | Add metadata to telemetry/export tools.                                  | `/telemetry status`, `/telemetry retry`.                                | Export status panel and failure card.               | Subscribe to agent/tool events and schedule retries.                |
| Long-running job monitor   | Job ids, progress, owner, cancellation state.               | Inject completion/failure summary into next active turn.   | Decorate job tools and gate cancellation.                                | `/job status`, `/job cancel`, `/job follow`.                            | Progress card and completion notification.          | Poll jobs, emit heartbeats, clean up on session close.              |

## How The Hooks Enter The SDK

The implementation should land as SDK infrastructure, not as Plan Mode code.
Each hook family should have an explicit layer so plugin authors know which
parts are stable public API, which parts are trusted-only, and which parts are
gateway/UI protocol contracts.

| SDK layer                  | What changes                                                                                                                                                                                                                                                                          | Hook families involved                     | Review requirement                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Public plugin API          | Add typed registration functions such as `registerSessionExtension`, `enqueueNextTurnInjection`, command `requiredScopes`, command `continueAgent`, UI contribution registration, typed event subscription, run-context helpers, scheduler helpers, and heartbeat contribution hooks. | A, B, D, E, F plus public metadata from C. | Additive TypeScript types, plugin SDK docs, generated API reference if applicable, and compile-time fixture plugin usage. |
| Trusted/bundled plugin API | Add privileged registration for pre-plugin tool policy and reserved command ownership.                                                                                                                                                                                                | C and D.                                   | Manifest trust declaration, bundled-only enforcement, negative tests for external plugins, and clear security docs.       |
| Manifest/schema            | Declare trusted capabilities, command roots, UI contribution ids, optional required scopes, and any cold-discovery metadata that should be visible before runtime activation.                                                                                                         | C, D, E, possibly F.                       | Manifest validation tests and disabled-plugin behavior tests.                                                             |
| Gateway protocol           | Add plugin session patch route/envelope, public session projection, UI contribution projection, tool metadata/catalog projection, and stable error codes.                                                                                                                             | A, C, E.                                   | Backward-compatible schema changes, scope enforcement tests, and client compatibility notes.                              |
| Agent runner boundary      | Add durable injection dequeue and `agent_turn_prepare` ordering before retry/fallback/provider transforms.                                                                                                                                                                            | B and F.                                   | Retry/fallback exactly-once tests and deterministic prompt ordering tests.                                                |
| Control UI contract        | Consume descriptor-only plugin contributions for chat modes, generic cards, status surfaces, event classifiers, and input guards.                                                                                                                                                     | E plus metadata from C.                    | No arbitrary plugin browser code in the first version; descriptor sanitization and enable/disable tests.                  |
| Lifecycle cleanup          | Clean plugin-owned state, injections, run context, scheduler jobs, UI descriptors, policies, tools, and commands on plugin disablement, session reset, session delete, compaction, and gateway restart.                                                                               | A through F.                               | Fixture tests for disablement, reset, delete, restart, and projection cleanup.                                            |
| Fixture plugin tests       | Add a tiny plugin that exercises every new seam without product behavior.                                                                                                                                                                                                             | A through F.                               | The fixture is the contract guardrail for Plan Mode and future third-party plugins.                                       |

Plugin authors should be able to answer six questions from the SDK docs after
these hooks land:

1. Where do I store per-session plugin state without adding fields to core
   `SessionEntry`?
2. How do I schedule exactly-once instructions for the next agent turn?
3. How do I enforce trusted tool policy before ordinary plugin hooks and explain
   tool risk in UI/catalogs?
4. How do my slash commands declare required scopes, patch state, and
   optionally resume the agent?
5. How do I project mode, status, cards, and input guards into Control UI
   without shipping arbitrary browser code?
6. How do I subscribe to run events, keep run-scoped data, schedule
   session-owned work, and clean it up on reset, delete, and plugin
   disablement?

## Maintainer Decision To Make

The decision is not "merge PR #71676 or reject Plan Mode." The useful decision
is broader:

> Which host seams must OpenClaw expose so Plan Mode can be implemented as a
> first-class bundled plugin without reversible installer patches or scattered
> core edits, and so future plugins can reuse the same SDK primitives?

The proposed answer is six hook families:

| RFC | Hook family                                                  | Required before Plan Mode plugin parity? | Reusable SDK reason                                                                                                                           |
| --- | ------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Plugin session extensions and patch actions                  | Yes                                      | Any plugin with durable per-session workflow state needs host storage, projection, patch authorization, and lifecycle cleanup.                |
| B   | Durable next-turn injections and agent turn preparation      | Yes                                      | Any plugin that converts a later approval, event, timer, or channel callback into the next agent turn needs exactly-once turn preparation.    |
| C   | Trusted tool policy and plugin tool metadata                 | Yes                                      | Any plugin enforcing workspace, budget, approval, release, or safety policy needs a non-bypassable policy tier and explainable tool metadata. |
| D   | Scoped plugin commands and command continuation              | Yes                                      | Any plugin with mutating slash commands needs host-enforced scopes and the option to resume the agent after command-side state changes.       |
| E   | Control UI contribution slots                                | Yes for first-class UX                   | Any plugin with modes, approvals, warnings, status, or input guards needs a data-driven UI slot instead of checked-in UI patches.             |
| F   | Agent event, run context, scheduler, and heartbeat lifecycle | Yes for full parity                      | Any plugin that reacts to runs, tools, subagents, timers, or recurring reminders needs typed event subscriptions and host-owned cleanup.      |

The hook PR should implement those seams with a tiny fixture plugin. The Plan
Mode plugin should come after the hook PR and use PR #71676 as its parity
oracle.

## Already Implemented Comparison

This RFC packet should not ask maintainers to guess whether an existing hook is
"close enough." The table below is the #71427-style comparison for the six
requested SDK seams.

| RFC | Existing SDK surface that may look similar                                                           | Why it is not enough                                                                                                                                         | Non-Plan plugin consumers                                                                 |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| A   | Fixed `sessions.patch`, hardcoded session rows, internal `session:patch`, plugin gateway RPC scopes. | There is no namespaced plugin session extension with host-owned patch validation, projection, broadcast, lifecycle cleanup, and disabled-plugin behavior.    | review gates, release workflows, memory managers, budget governors, channel bindings      |
| B   | `before_prompt_build`, legacy `before_agent_start`, and in-memory system events.                     | These are current-turn prompt hooks, not a durable exactly-once next-turn queue with retry-safe dequeue, expiry, dedupe, and disabled-plugin suppression.    | CI triage, incident handoff, memory hydration, channel retries, approval continuations    |
| C   | Normal `before_tool_call`, core config filtering, basic plugin tool catalog fields.                  | Normal hooks share plugin ordering; there is no bundled/trusted pre-plugin policy tier, metadata/display registry, or core-tool decoration rule.             | budget guards, workspace policy, deploy freezes, dangerous-action approvals               |
| D   | `api.registerCommand(...)`, `gatewayClientScopes` in context, scoped plugin gateway methods.         | Plugins can inspect scopes manually, but commands cannot declare host-enforced scopes, trusted reserved-root ownership, or `continueAgent`.                  | deploy approvals, review commands, budget overrides, incident commands, channel commands  |
| E   | Remote slash commands and generic plugin approval cards.                                             | Existing UI support covers discovery and one generic card class, not chat modes, input guards, status surfaces, event classifiers, or descriptor projection. | approval workflows, release dashboards, budget warnings, incident banners, memory panels  |
| F   | Raw `runtime.events.onAgentEvent`, internal run context, `gateway_start.getCron`, prompt hooks.      | Plugins lack typed filtered event subscriptions, namespaced run context, session-owned scheduler cleanup, and heartbeat contribution ordering.               | telemetry exporters, memory indexers, CI watchers, incident escalators, long-running jobs |

## Why Current SDK Surfaces Are Not Enough

OpenClaw already has a useful plugin system:

- `api.registerTool(...)`
- `api.registerCommand(...)`
- `api.registerHook(...)` and `api.on(...)`
- `api.registerGatewayMethod(...)`
- `api.registerInteractiveHandler(...)`
- lifecycle hooks such as `before_prompt_build`, `before_tool_call`, and
  `gateway_start`

Those seams are not enough for Plan Mode parity because Plan Mode crosses
boundaries that current plugins cannot own safely:

- It needs typed, durable session state visible to gateway clients.
- It needs state mutation through `sessions.patch`-class authorization and
  broadcast behavior.
- It needs pending instructions to be consumed exactly once at the next agent
  turn boundary.
- It needs a mutation gate that runs before normal plugin `before_tool_call`
  hooks.
- It needs command handlers to require approval scope and continue the agent.
- It needs first-class Control UI contributions without checked-in UI patches.
- It needs agent event subscriptions and run-scoped state without exposing raw
  mutable internals.
- It needs scheduled jobs and heartbeat prompt contributions tied to session
  lifecycle.

If these seams are not added, the "plugin" version becomes one of two bad
things:

- a partial plugin with real feature regressions, or
- a plugin installer that patches host files, which is not first-class plugin
  behavior.

## Evidence From PR 71676

PR #71676 touches a broad surface because it implements Plan Mode directly in
host code. That breadth is the evidence for the missing seams. Paths in this
table are repo-root relative as they appear in the #71676 branch/diff; some are
intentionally absent from current `main` because #71676 is the parity oracle,
not code to cherry-pick.

| Behavior in PR #71676                                        | Representative host files                                                                                                                                                        | What this proves                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Plan state and approval state are persisted on sessions      | `src/config/sessions/types.ts`, `src/gateway/protocol/schema/sessions.ts`, `src/gateway/sessions-patch.ts`, `src/gateway/session-utils.ts`, `src/gateway/session-utils.types.ts` | Plugin state needs a typed persistence and gateway projection contract.                                     |
| Plan approval actions mutate sessions                        | `src/gateway/sessions-patch.ts`, `src/gateway/server-methods/sessions.ts`, `src/gateway/protocol/schema/error-codes.ts`                                                          | Plugin patch actions need the same authorization, validation, and broadcast path as native session patches. |
| Pending agent injections are queued and drained              | `src/auto-reply/reply/agent-runner-execution.ts`, `src/agents/pi-embedded-runner/pending-injection.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`                           | Prompt hooks are too weak; a durable next-turn queue is needed.                                             |
| Plan prompt rules are injected at run time                   | `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-runner/system-prompt.ts`, `src/agents/system-prompt.ts`                                                  | The plugin needs deterministic turn-preparation contributions.                                              |
| Mutating tools are blocked during unapproved plan mode       | `src/agents/pi-tools.before-tool-call.ts`, `src/agents/pi-tools.ts`                                                                                                              | A trusted tool policy stage must precede ordinary plugin hooks.                                             |
| Plan Mode adds agent tools                                   | `src/agents/openclaw-tools.ts`, `src/agents/openclaw-tools.registration.ts`, `src/agents/tool-catalog.ts`, `src/agents/tool-display-config.ts`                                   | Plugin-owned tools need catalog, display, and safety metadata.                                              |
| `/plan` is hardwired as a command                            | `src/auto-reply/reply/commands-plan.ts`, `src/auto-reply/reply/commands-handlers.runtime.ts`, `src/plugins/command-registration.ts`                                              | Plugin commands need scoped auth, trusted command ownership, and continuation.                              |
| Plan approval cards are hardwired in the web UI              | `ui/src/ui/chat/mode-switcher.ts`, `ui/src/ui/app-tool-stream.ts`, `ui/src/ui/app-render.ts`, `ui/src/ui/views/plan-approval-inline.ts`, `ui/src/styles/chat/plan-cards.css`     | Control UI needs plugin contribution slots for mode chips and approval renderers.                           |
| Plan snapshots and approvals are persisted from agent events | `src/infra/agent-events.ts`, `src/gateway/plan-snapshot-persister.ts`, `src/gateway/server-runtime-subscriptions.ts`                                                             | Plugin code needs safe agent event subscriptions and run-context storage.                                   |
| Nudges are scheduled and injected into heartbeat prompts     | `src/infra/heartbeat-runner.ts`, `src/cron/*`, `src/cron/isolated-agent/run.ts`                                                                                                  | Plugins need session-scoped scheduler lifecycle and heartbeat prompt contribution.                          |

The host-hook PR should not copy those implementations. It should replace the
host-specific edits with generic extension points.

## PR 71676 Entry-Point Coverage Map

The goal is not to preserve every file touched by PR #71676. The goal is to
preserve every behavior class while moving Plan Mode-specific code into a
plugin package. This map is the parity checklist for the future implementation
PR.

| PR #71676 entry point                                                         | Current patch shape                                                                           | Required SDK hook family                        | Parity requirement for plugin port                                                                                                                                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session model, gateway schema, and generated app client models                | Adds root session fields and updates gateway/client model shapes.                             | RFC A plus RFC E projection.                    | Plugin state lives under a namespaced session extension, projects safe public fields to gateway rows/details, and keeps client model generation additive.           |
| `sessions.patch` and approval mutation routing                                | Adds Plan Mode-specific patch actions and validation.                                         | RFC A plus RFC D for command-triggered actions. | Plugin patch actions use host validation, authorization, error codes, persistence, and session-change broadcasts.                                                   |
| Agent prompt preparation and pending interaction queue                        | Adds pending injections and runner wiring.                                                    | RFC B.                                          | Approval accept, revise, question answer, nudge, and subagent follow-up instructions reach the next turn exactly once across retry/fallback/provider transforms.    |
| Plan prompt rules and runtime state hydration                                 | Adds Plan Mode runtime context to prompt assembly.                                            | RFC B plus RFC F run context.                   | Plugin contributes deterministic turn-preparation context without editing runner internals or global prompt files.                                                  |
| Tool mutation gate while approval is pending                                  | Adds Plan Mode logic around tool execution.                                                   | RFC C.                                          | Trusted bundled policy blocks or requires approval before ordinary plugin `before_tool_call` hooks can mutate or reorder the call.                                  |
| Plan Mode tools and `update_plan` integration                                 | Adds or modifies tool registrations, catalog data, display data, and plan telemetry behavior. | RFC C.                                          | Plugin-owned tools publish metadata; core-owned tools such as `update_plan` are either safely decorated or explicitly left as telemetry with parallel plugin tools. |
| Slash commands in web, text channels, and Telegram flows                      | Adds `/plan` handling and text-channel behaviors.                                             | RFC D plus RFC B.                               | Plugin commands declare scopes, mutate plugin state, enqueue continuations, and optionally resume the agent without channel-specific core patches.                  |
| Control UI mode switcher, approval/question cards, composer behavior, and CSS | Adds host-known Plan Mode UI components.                                                      | RFC E.                                          | UI consumes descriptor-only plugin contributions for modes, generic cards, status surfaces, event classifiers, and input guards.                                    |
| Agent events, plan snapshots, approval lifecycle, and subagent gates          | Adds Plan Mode-specific event subscribers and derived state persistence.                      | RFC F plus RFC A.                               | Plugin receives typed/sanitized events, stores derived state in its extension, and tracks per-run/subagent data with host-owned cleanup.                            |
| Cron jobs, nudges, and heartbeat prompt content                               | Adds Plan Mode-specific scheduling and heartbeat prompt behavior.                             | RFC F plus RFC B.                               | Plugin creates session-owned jobs, cleans them on reset/delete/disable, and contributes heartbeat or next-turn context through a documented hook.                   |
| Docs, skills, QA scenarios, rollout patch, and operator runbooks              | Adds product documentation and testing around Plan Mode behavior.                             | Plugin package docs plus fixture tests.         | Hook PR keeps only generic SDK docs/tests; Plan Mode plugin owns product docs, skills, prompts, QA, rollout, and channel-specific behavior.                         |

If a future hook implementation PR cannot satisfy a row above with a fixture
plugin, the Plan Mode plugin port should not claim 100% parity with PR #71676.

## Current Plugin Surface Gap Analysis

| Existing plugin surface          | Useful for Plan Mode              | Missing piece                                                                                                               |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `api.registerTool(...)`          | Registers Plan Mode tools.        | No shared tool catalog/display metadata; no safe way to decorate a core-owned tool such as `update_plan`.                   |
| `before_tool_call`               | Can observe and block tools.      | Runs at normal plugin priority; Plan Mode policy must be host-trusted and pre-plugin to prevent bypass or ordering bugs.    |
| `before_prompt_build`            | Can add prompt context.           | Not durable, not exactly-once, not tied to persisted pending interactions, and not a future-turn queue.                     |
| `api.registerCommand(...)`       | Registers `/plan`-style commands. | No declarative scopes, no trusted root ownership, and command execution defaults to stopping instead of resuming the agent. |
| `api.registerGatewayMethod(...)` | Could expose plugin RPCs.         | Does not integrate with session patch semantics, session row projection, or `sessions.changed` broadcasts.                  |
| `gateway_start` with `getCron`   | Can schedule background jobs.     | No session-extension lifecycle cleanup and no heartbeat prompt contribution path.                                           |
| Existing UI code                 | Can render host-known cards.      | No data-driven plugin UI contribution registry for chat modes, approval cards, input guards, or plugin events.              |
| Existing agent event internals   | Host can persist derived state.   | Plugins do not get a safe, stable subscription API or run-scoped extension bag.                                             |

## Compatibility Principles

The hook PR must follow these principles:

- Additive gateway protocol changes only.
- Additive plugin SDK changes only.
- No Plan Mode-specific ids, states, fields, or prompt text in core.
- No external plugin escalation into trusted policy hooks by default.
- No eager loading of broad plugin runtime surfaces for cold UI discovery.
- Deterministic prompt, hook, and metadata ordering.
- Stable failure behavior: invalid plugin state patches fail closed.
- Plugin disablement removes tools, commands, UI contributions, policy gates,
  scheduled jobs, and heartbeat contributions.

## RFC A: Plugin Session Extensions And Patch Actions

### RFC A Problem

Plan Mode is durable session state. It needs to store whether a session is in
normal mode, planning mode, approval-pending mode, approved execution mode, or
auto-approve mode. It also needs to store metadata such as current cycle id,
last plan steps, pending question, pending injection ids, blocking subagent ids,
and nudge job ids.

Adding those fields directly to `SessionEntry` makes the feature core-owned.
Keeping them in plugin-private files breaks gateway projection, UI state,
authorization, and session lifecycle.

### RFC A Proposed API Shape

```ts
type PluginSessionExtensionRegistration<TState, TPublic, TAction> = {
  key: string;
  schema: {
    state: unknown;
    action: unknown;
  };
  initialState?: () => TState | undefined;
  publicProjection?: (state: TState, ctx: PluginSessionProjectionContext) => TPublic | undefined;
  patchActions: {
    [actionType: string]: PluginSessionPatchAction<TState, TAction>;
  };
  lifecycle?: {
    onReset?: PluginSessionLifecycleHandler<TState>;
    onDelete?: PluginSessionLifecycleHandler<TState>;
    onCompaction?: PluginSessionLifecycleHandler<TState>;
    onMigration?: PluginSessionMigrationHandler<TState>;
  };
};

api.registerSessionExtension(registration);
```

A gateway patch action can be represented as either:

```ts
{
  sessionKey: string;
  plugin: {
    key: "plan-mode";
    action: "submitApproval";
    payload: {
      decision: "accept";
    }
  }
}
```

or a dedicated method:

```ts
sessions.pluginPatch({
  sessionKey,
  pluginKey: "plan-mode",
  action: "submitApproval",
  payload,
});
```

The dedicated method is cleaner for review because it avoids growing
`sessions.patch` into an unbounded plugin envelope. The additive envelope is
more ergonomic for existing session clients. Maintainers should choose one
shape before implementation.

### RFC A Host Files

Likely host files for the hook PR:

- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/plugins/captured-registration.ts`
- `src/plugins/api-builder.ts`
- `src/config/sessions/types.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/session-utils.ts`
- `src/gateway/session-utils.types.ts`
- `src/gateway/sessions-patch.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/protocol/schema/error-codes.ts`
- `src/plugins/contracts/plugin-sdk-subpaths.test.ts`
- `src/plugins/contracts/registry.contract.test.ts`

### RFC A Authorization Model

Session extension patch actions must declare required gateway scopes:

```ts
patchActions: {
  submitApproval: {
    requiredScopes: ["operator.approvals"],
    handler,
  },
  readStatus: {
    requiredScopes: ["sessions.read"],
    handler,
  },
}
```

The gateway must enforce scopes before invoking the plugin action. Plugins
should not reimplement scope checking manually.

### RFC A Projection Model

Plugin state must not be dumped wholesale into every client response. Each
extension should return an explicit public projection:

```ts
publicProjection(state) {
  return {
    mode: state.mode,
    approvalStatus: state.approval?.status,
    title: state.approval?.title,
    updatedAt: state.updatedAt,
  };
}
```

Private fields such as raw prompts, internal queue ids, or plugin-specific
scheduler ids can remain hidden.

### RFC A Failure Behavior

- Unknown plugin key: stable `PLUGIN_SESSION_EXTENSION_NOT_FOUND` error.
- Unknown action: stable `PLUGIN_SESSION_EXTENSION_ACTION_NOT_FOUND` error.
- Invalid payload: stable `PLUGIN_SESSION_EXTENSION_INVALID_PAYLOAD` error.
- Disabled plugin: stable `PLUGIN_DISABLED` or equivalent existing disabled
  plugin error.
- Handler throws: fail closed and do not partially persist state.
- Projection throws: omit projection and log a plugin error; do not break
  session listing.

### RFC A Plan Mode Mapping

Plan Mode plugin state can be modeled as:

```ts
type PlanModeSessionState = {
  mode: "normal" | "plan" | "plan_auto";
  cycleId?: string;
  approval?: {
    status: "drafting" | "pending" | "approved" | "rejected" | "cancelled";
    title?: string;
    summary?: string;
    submittedAt?: string;
    decidedAt?: string;
  };
  lastPlanSteps?: Array<{ step: string; status: string }>;
  pendingQuestion?: {
    id: string;
    prompt: string;
    choices?: Array<{ label: string; description?: string }>;
  };
  pendingInjectionIds?: string[];
  blockingSubagentRunIds?: string[];
  nudgeJobIds?: string[];
};
```

This state should live under a plugin namespace, not on the root session entry.

### RFC A Reusable SDK Scenarios

Session extensions are useful for any plugin that owns durable per-session
workflow state:

- review gates can store PR id, unresolved findings, reviewer decisions, and
  merge gate state
- release plugins can store environment, rollout phase, freeze window, and
  rollback id
- memory managers can store pins, recall cursors, compaction policy, and source
  visibility
- budget governors can store spend counters, thresholds, override decisions,
  and expiry
- channel plugins can store thread bindings, delivery preferences, and auth
  handoff state
- incident bots can store severity, owner, ticket sync cursor, and SLA deadline

### RFC A Fixture Tests

Required fixture coverage:

- A fixture plugin registers an extension and receives a patch action.
- Invalid patch payload fails without writing state.
- Disabled plugin extension cannot be patched.
- Public projection appears in session row output.
- Private extension fields are not projected.
- Session reset invokes extension lifecycle cleanup.
- Session delete removes extension state.

## RFC B: Durable Next-Turn Injections And Agent Turn Preparation

### RFC B Problem

Plan Mode cannot rely only on `before_prompt_build`. Approval acceptance,
revision requests, user question answers, scheduled nudges, and subagent
follow-ups must affect a future agent turn exactly once.

A prompt hook is ephemeral. It can add context to the current prompt, but it
does not provide a durable pending queue that survives command handling,
retries, gateway restarts, or delayed scheduled jobs.

### RFC B Proposed API Shape

```ts
type NextTurnInjection = {
  id: string;
  pluginKey: string;
  sessionKey: string;
  targetRunId?: string;
  role: "user" | "system";
  content: string;
  reason: string;
  createdAt: string;
  expiresAt?: string;
  dedupeKey?: string;
};

api.enqueueNextTurnInjection(injection);

api.on("agent_turn_prepare", async (event, ctx) => {
  return {
    prependSystemContext: "string",
    prependUserMessages: [{ content: "string" }],
  };
});
```

The host should own storage and dequeue. A plugin should not patch runner
arguments directly.

### RFC B Dequeue Semantics

The runner should consume injections:

1. after the inbound command or chat message has resolved the target session,
2. before the agent retry/fallback loop starts,
3. before provider-specific transforms,
4. exactly once per injection id,
5. transactionally with session state update.

If a run is retried inside the same user action, the same consumed injection
should remain part of that run's prepared prompt but should not be consumed
again as a new pending item.

### RFC B Host Files

Likely host files for the hook PR:

- `src/plugins/hook-types.ts`
- `src/plugins/hooks.ts`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/config/sessions/types.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/params.ts`
- `src/agents/cli-runner/prepare.ts`
- `src/agents/harness/prompt-compaction-hook-helpers.ts`

### RFC B Ordering Contract

Recommended prompt assembly order:

1. host base system prompt
2. stable provider or harness prompt overlays
3. plugin `agent_turn_prepare.prependSystemContext`
4. existing `before_prompt_build` system contributions
5. durable system-role next-turn injections
6. durable user-role next-turn injections
7. current user prompt

Maintainers may choose a different order, but it must be documented and tested.

### RFC B Plan Mode Mapping

Plan Mode uses next-turn injections for:

- approved plan execution instructions
- revise-plan instructions
- answer-to-pending-question payloads
- scheduled plan nudges
- subagent finished-follow-up instructions
- "continue after approval" command flow

### RFC B Reusable SDK Scenarios

Durable next-turn injections are useful for any plugin that receives a decision,
event, timer, or channel callback outside the current model call and needs to
feed the next agent turn exactly once:

- review plugins can inject required fixes after an asynchronous review pass
- deployment plugins can inject a release checklist after human approval
- memory managers can hydrate selected context before the next model call
- incident plugins can inject escalation or handoff instructions after an SLA
  timer fires
- CI plugins can inject the next diagnostic step after log fetching completes
- channel plugins can inject deferred replies or cross-channel follow-ups

### RFC B Failure Behavior

- Invalid injection payload fails before persisting.
- Expired injection is discarded with a diagnostic event.
- Disabled plugin's pending injections are ignored or removed.
- Missing session key fails closed.
- Duplicate `dedupeKey` updates or drops according to a documented policy.

### RFC B Fixture Tests

Required fixture coverage:

- A fixture plugin enqueues an injection and the next run receives it.
- Injection is consumed exactly once.
- Retry/fallback does not duplicate the injection.
- Expired injection does not reach the model.
- Plugin disablement suppresses pending injections.
- Existing `before_prompt_build` tests still pass.

## RFC C: Trusted Tool Policy And Plugin Tool Metadata

### RFC C Problem

Plan Mode blocks mutating tools while approval is pending. That gate must be
stronger than ordinary plugin `before_tool_call` hooks because normal plugins
may also mutate params, require approvals, or block/allow calls. A Plan Mode
mutation gate should not depend on arbitrary hook priority.

Plan Mode tools also need first-class display metadata. Today plugin tools can
be registered, but catalog and UI display metadata are still partly host-owned.

### RFC C Proposed Policy API Shape

```ts
type ToolPolicyDecision =
  | { allow: true }
  | { block: true; reason: string; code?: string }
  | { requireApproval: true; reason: string; approvalKind?: string };

api.registerToolPolicy({
  id: "plan-mode.mutation-gate",
  stage: "pre_plugin_hooks",
  trust: "bundled",
  handler: async (event, ctx) => ToolPolicyDecision,
});
```

The first implementation should only allow trusted bundled plugins to register
`pre_plugin_hooks` policy. External plugins can continue to use
`before_tool_call`.

### RFC C Proposed Metadata API Shape

```ts
api.registerToolMetadata({
  name: "plan_mode_status",
  title: "Plan mode status",
  category: "planning",
  display: {
    icon: "clipboard-check",
    compactLabel: "Plan status",
  },
  safety: {
    mutatesState: false,
    requiresApproval: false,
  },
});
```

Metadata should be deterministic and should disappear when the plugin is
disabled.

### RFC C Core-Owned Tool Decoration

Plan Mode may need to extend the meaning of the existing `update_plan` tool.
That should not require replacing the tool. Add an explicit decoration seam:

```ts
api.decorateTool({
  name: "update_plan",
  metadata,
  eventMapper,
});
```

If maintainers do not want a generic decoration API yet, the Plan Mode plugin
should own parallel tools and consume `update_plan` only as ordinary telemetry.
This is an explicit RFC decision.

### RFC C Host Files

Likely host files for the hook PR:

- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/plugins/hook-types.ts`
- `src/plugins/hooks.ts`
- `src/agents/pi-tools.before-tool-call.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/tool-catalog.ts`
- `src/agents/tool-display-config.ts`
- `ui/src/ui/tool-display.ts`
- `ui/src/ui/chat/tool-cards.ts`

### RFC C Plan Mode Mapping

Plan Mode uses tool policy for:

- blocking write/edit/shell/browser mutation tools during pending approval
- allowing read-only/status tools during planning
- allowing Plan Mode tools that manage approval state
- optionally requiring a separate approval for high-risk post-approval actions

Plan Mode uses tool metadata for:

- `enter_plan_mode`
- `exit_plan_mode`
- `ask_user_question`
- `plan_mode_status`
- any future plan artifact export tool

### RFC C Reusable SDK Scenarios

Trusted tool policy and tool metadata are useful for any plugin that needs both
policy enforcement and explainable tool presentation:

- budget plugins can block or require approval for expensive tools or models
- workspace policy plugins can block filesystem, browser, or network tools that
  violate path or data-egress rules
- deployment plugins can gate deploy and rollback tools during freeze windows
- dangerous-action wrappers can require scoped approval for high-risk mutation
  tools
- compliance plugins can add audit and safety labels to plugin-owned tools
- tool catalog extensions can publish display, risk, category, and ownership
  metadata without hardcoding host display maps

### RFC C Fixture Tests

Required fixture coverage:

- A trusted fixture policy blocks before ordinary `before_tool_call`.
- A normal plugin cannot override a trusted block.
- External plugin cannot register `pre_plugin_hooks` policy.
- Fixture tool metadata appears in tool display lookup.
- Disabling the fixture plugin removes its metadata and policy.

## RFC D: Scoped Plugin Commands And Command Continuation

### RFC D Problem

Plan Mode needs slash commands that do more than return a text response.
Examples include:

- `/plan status`
- `/plan accept`
- `/plan revise <instructions>`
- `/plan answer <question-id> <answer>`
- `/plan auto on`
- `/plan auto off`

Mutating commands need approval scope. Some commands need to resume the agent
after the command has patched session state or enqueued a next-turn injection.
Current plugin commands do not declare scopes and default to stopping command
processing.

### RFC D Proposed API Shape

```ts
api.registerCommand({
  name: "plan",
  requiredScopes: ["operator.approvals"],
  ownership: "trusted-core-command",
  handler: async (ctx) => {
    return {
      message: "Plan accepted. Continuing.",
      continueAgent: true,
      delivery: "ephemeral",
    };
  },
});
```

The existing behavior should remain the default:

- no `requiredScopes` means current auth behavior
- no `continueAgent` means do not resume the agent
- untrusted plugins cannot claim core-reserved roots

### RFC D Host Files

Likely host files for the hook PR:

- `src/plugins/types.ts`
- `src/plugins/commands.ts`
- `src/plugins/command-registration.ts`
- `src/auto-reply/reply/commands-plugin.ts`
- `src/auto-reply/reply/commands-handlers.runtime.ts`
- `src/auto-reply/commands-registry.shared.ts`
- `src/gateway/protocol/schema/scopes.ts` if scopes are centralized there

### RFC D Command Ownership

Maintainers should choose one trusted ownership model:

| Option              | Description                                               | Pros                                       | Cons                                 |
| ------------------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| Manifest ownership  | Plugin manifest declares trusted command roots.           | Cold discovery and docs can see ownership. | Requires manifest schema change.     |
| Runtime ownership   | `registerCommand` declares trusted ownership.             | Simple and direct.                         | Requires runtime load to know claim. |
| Two-phase ownership | Manifest declares claim; runtime confirms implementation. | Best for UI/help/discovery.                | More implementation work.            |

For Plan Mode, two-phase ownership is probably best if the command should
appear in slash command help before the full plugin runtime is activated.

### RFC D Plan Mode Mapping

Plan Mode commands would:

- inspect plugin session extension state
- call plugin session patch actions
- enqueue next-turn injections when needed
- return `continueAgent: true` when execution should resume
- return read-only status without continuation for `/plan status`

### RFC D Reusable SDK Scenarios

Scoped command continuation is useful for any plugin whose slash commands mutate
state and then optionally resume the agent:

- `/review approve`, `/review request-changes`, and `/review rerun`
- `/deploy approve`, `/deploy pause`, `/rollback`, and `/release status`
- `/budget override`, `/budget reset`, and `/budget status`
- `/incident ack`, `/incident escalate`, and `/ticket close`
- `/memory pin`, `/memory forget`, and `/context refresh`
- `/policy grant`, `/policy revoke`, and `/policy explain`
- `/telegram approve`, `/slack handoff`, and `/email summarize`

### RFC D Fixture Tests

Required fixture coverage:

- Command requiring `operator.approvals` rejects insufficient scope.
- Read-only fixture command works with read scope only.
- Command returning `continueAgent: true` resumes agent execution.
- Command returning no continuation preserves current behavior.
- Untrusted plugin cannot claim a reserved command root.

## RFC E: Control UI Plugin Contribution Slots

### RFC E Problem

Plan Mode is not first-class if its UI requires patching the web app. A plugin
needs to contribute:

- mode switcher entries
- approval cards
- question cards
- event stream classifiers
- chat input guards
- optional side-panel or inline status sections

Arbitrary plugin JavaScript in the browser is too much for the first version.
The initial Control UI surface should be declarative and data-driven.

### RFC E Proposed API Shape

```ts
api.registerControlUiContribution({
  id: "plan-mode.ui",
  chatModes: [
    {
      id: "plan",
      label: "Plan",
      description: "Draft a plan before executing changes.",
      sessionPatchAction: {
        pluginKey: "plan-mode",
        action: "setMode",
        payload: { mode: "plan" },
      },
    },
  ],
  approvalRenderers: [
    {
      kind: "plan-mode.approval",
      component: "approval-card",
      actions: ["accept", "revise", "cancel"],
    },
  ],
  inputGuards: [
    {
      when: { extension: "plan-mode", field: "approval.status", equals: "pending" },
      message: "Plan approval is pending.",
    },
  ],
});
```

This shape is illustrative. The important requirement is that the UI can render
plugin-owned state and actions without importing plugin browser code.

### RFC E Gateway Projection

The gateway should expose enabled UI contributions through a plugin registry or
session bootstrap method. The UI should receive:

- contribution id
- owning plugin id
- chat mode entries
- approval renderer descriptors
- event classifier descriptors
- input guard descriptors
- version or schema id

Disabled plugins must not contribute UI descriptors.

### RFC E Host Files

Likely host files for the hook PR:

- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/gateway/server-methods/plugins.ts` or equivalent plugin registry method
- `ui/src/ui/types.ts`
- `ui/src/ui/chat/mode-switcher.ts`
- `ui/src/ui/app-tool-stream.ts`
- `ui/src/ui/app-render.ts`
- `ui/src/ui/views/chat.ts`
- `ui/src/styles/chat/layout.css`

### RFC E Plan Mode Mapping

Plan Mode UI contribution should replace host patches for:

- Plan and Plan Auto mode entries
- inline approval card
- inline question card
- approval event parsing
- session status badge or sidebar section
- composer guard when approval is pending

### RFC E Reusable SDK Scenarios

Control UI contribution slots are useful for any plugin that needs visible state
or safe user interaction without patching the web app:

- human approval plugins can render approval cards and pending banners
- release plugins can show rollout progress, deploy approval cards, and freeze
  banners
- budget governors can show spend meters, override cards, and blocked-input
  hints
- memory/context plugins can show context panels, source visibility cards, and
  memory pickers
- incident plugins can show severity banners, SLA countdowns, and ticket action
  cards
- channel plugins can show auth cards, delivery status, and channel-specific
  input guards

### RFC E Fixture Tests

Required fixture coverage:

- Fixture chat mode appears when plugin is enabled.
- Fixture chat mode disappears when plugin is disabled.
- Fixture approval payload renders through a generic card renderer.
- Fixture action sends the expected plugin patch action.
- Input guard disables or annotates composer based on projected state.

## RFC F: Agent Events, Run Context, Scheduler, And Heartbeat Lifecycle

### RFC F Problem

Plan Mode needs to observe and react to agent lifecycle facts:

- plan snapshots
- approval submissions
- tool calls
- subagent starts and finishes
- run completion
- run cancellation
- scheduled nudges
- heartbeat prompt assembly

The host should not expose raw mutable event bus internals to plugins. It
should expose stable event subscriptions, run-scoped plugin data, and
session-scoped scheduler lifecycle helpers.

### RFC F Proposed Event API Shape

```ts
api.onAgentEvent("run_completed", async (event, ctx) => {
  const state = await ctx.sessions.getExtensionState(event.sessionKey, "plan-mode");
  await ctx.sessions.patchExtension(event.sessionKey, "plan-mode", {
    action: "closeCycle",
    payload: { runId: event.runId },
  });
});
```

Event subscription should be stable and typed. The plugin should receive
read-only event data plus safe gateway/session helpers.

### RFC F Proposed Run Context API Shape

```ts
ctx.runContext.set("plan-mode", {
  cycleId,
  enteredPlanModeAt,
});

const value = ctx.runContext.get("plan-mode");
```

Run context data should be automatically cleaned up when the run completes.

### RFC F Proposed Scheduler API Shape

```ts
ctx.scheduler.createSessionJob({
  pluginKey: "plan-mode",
  sessionKey,
  kind: "heartbeat",
  schedule,
  payload,
});

ctx.scheduler.deleteSessionJobs({
  pluginKey: "plan-mode",
  sessionKey,
});
```

Existing `gateway_start.getCron` can remain for low-level cron access, but Plan
Mode needs session lifecycle cleanup and consistent ownership.

### RFC F Proposed Heartbeat Hook Shape

```ts
api.on("heartbeat_prompt_contribution", async (event, ctx) => {
  return {
    prependUserContext: "The approved plan is still pending execution...",
  };
});
```

This could also be modeled as a specialized `agent_turn_prepare` event. The RFC
decision is whether heartbeat turns should use a dedicated hook for clarity.

### RFC F Host Files

Likely host files for the hook PR:

- `src/infra/agent-events.ts`
- `src/gateway/server-runtime-subscriptions.ts`
- `src/infra/heartbeat-runner.ts`
- `src/cron/types.ts`
- `src/cron/normalize.ts`
- `src/cron/isolated-agent/run.ts`
- `src/plugins/hook-types.ts`
- `src/plugins/hooks.ts`
- `src/plugins/types.ts`

### RFC F Plan Mode Mapping

Plan Mode uses this hook family for:

- persisting latest plan snapshot
- marking approval cycle completion
- tracking blocking subagent ids
- following up when subagents settle
- creating and cancelling auto-nudge jobs
- adding heartbeat prompt nudges
- cleaning up jobs when session state resets

### RFC F Reusable SDK Scenarios

Agent events, run context, scheduler lifecycle, and heartbeat contributions are
useful for any plugin that reacts to runtime facts or owns background work:

- telemetry exporters can subscribe to sanitized events and batch scheduled
  exports
- memory indexers can observe run/tool events and refresh derived context
- CI watchers can poll workflows and inject completion or failure summaries
- incident bots can schedule SLA escalations and heartbeat unresolved incidents
- channel plugins can track delivery events and retry failed sends
- long-running job monitors can poll job state, emit progress, and clean up on
  session close
- subagent coordinators can store per-run state and inject follow-up once
  subagents settle

### RFC F Fixture Tests

Required fixture coverage:

- Fixture plugin receives a safe agent event.
- Fixture plugin writes derived session extension state from an event.
- Run context data is available during a run and cleaned after completion.
- Session reset deletes fixture-owned scheduled jobs.
- Heartbeat contribution appears only when extension state requests it.

## One Host-Hook PR Implementation Plan

This RFC defines the complete host-hook contract. The follow-up implementation
PR must implement all generic hooks needed before Plan Mode can be packaged as
a plugin with PR #71676 parity. That PR should be small relative to PR #71676
and should avoid Plan Mode feature logic. Recommended commit stack:

1. Add plugin session extension registry and patch action plumbing.
2. Add durable next-turn injection queue and agent turn preparation hook.
3. Add trusted tool policy stage and plugin tool metadata registry.
4. Add command scopes, trusted ownership, and `continueAgent`.
5. Add Control UI contribution projection and minimal renderer slots.
6. Add agent event subscription, run context, scheduler lifecycle, and
   heartbeat contribution helpers.
7. Add a tiny fixture plugin and contract tests.
8. Add docs and migration notes.

## Host-Hook PR Non-Negotiables

The hook PR should not include:

- Plan Mode prompts
- Plan Mode tools
- Plan Mode command text
- Plan Mode CSS
- Plan Mode hardcoded session fields
- Telegram-specific Plan Mode delivery behavior
- local installer patch logic
- Smarter-Claw-specific compatibility code

The hook PR should include:

- generic contracts
- tests that prove plugin ownership
- trust gates for privileged hooks
- disablement behavior
- docs for plugin authors and maintainers

## SDK Contract Fixture

Create a fixture plugin with no product behavior. Suggested id:
`host-hook-fixture`. This is not a Plan Mode fixture; it is a generic SDK
contract fixture that proves a reusable plugin can exercise every new seam.

The fixture should:

- register a session extension
- expose one public projection field
- handle one read-only patch action
- handle one mutating patch action
- enqueue one next-turn injection
- register one tool policy
- register one tool metadata record
- register one scoped command
- return `continueAgent: true` from one command path
- contribute one chat mode descriptor
- contribute one approval card descriptor
- observe one agent event
- store one run-context value
- create and clean up one session-scoped scheduled job
- contribute one heartbeat prompt string

The fixture plugin is the guardrail that future Plan Mode work depends on, but
it should model generic plugin classes such as:

- approval workflow: persistent approval state, scoped command, UI card, and
  continuation
- budget or workspace policy gate: trusted tool policy, metadata, override
  command, and warning UI
- background lifecycle plugin: event subscription, run context, scheduled job,
  heartbeat contribution, and cleanup

## Plan Mode Plugin Migration Sequence

After the hook PR lands:

1. Create a bundled Plan Mode plugin.
2. Move root session state into a plugin session extension.
3. Move approval and question actions into plugin patch actions.
4. Move Plan Mode tools into plugin registration.
5. Move mutation gate into trusted tool policy.
6. Move `/plan` commands into plugin command registration.
7. Move approval/revision/question continuations into next-turn injections.
8. Move web UI mode entries and approval cards into UI contributions.
9. Move snapshot persistence into agent event subscriptions.
10. Move nudge scheduling into scheduler lifecycle helpers.
11. Move heartbeat prompt text into heartbeat contribution hook.
12. Remove all Plan Mode hardcoded core patches.
13. Run feature-by-feature parity against PR #71676.

## Plan Mode Parity Checklist

The plugin port should not be considered complete until all of these are true:

- Agent can enter Plan Mode.
- Agent can exit Plan Mode.
- Agent can ask a pending user question.
- User can answer the pending question.
- Agent can submit a plan approval request.
- User can accept the plan.
- User can request revision.
- User can cancel or reject the plan.
- Accepted plan resumes execution.
- Revision resumes planning.
- Mutating tools are blocked while approval is pending.
- Read-only tools remain available while approval is pending.
- `update_plan` or equivalent plan telemetry remains visible.
- Plan and Plan Auto mode are visible in Control UI.
- Approval cards render in Control UI.
- Question cards render in Control UI.
- Slash commands work from text channels.
- Telegram command flow works without Telegram-specific core patches.
- Subagent follow-up gates work.
- Scheduled nudges work.
- Heartbeat nudges work.
- Session reset cleans Plan Mode state.
- Plugin disablement removes Plan Mode tools, commands, UI, policies, and jobs.

## Security Review Notes

This hook set expands plugin power. The implementation must define a trust
model.

Recommended trust tiers:

| Tier            | Can register normal hooks | Can register trusted tool policy | Can contribute UI    | Can patch session extension | Can own reserved commands     |
| --------------- | ------------------------- | -------------------------------- | -------------------- | --------------------------- | ----------------------------- |
| External plugin | Yes                       | No                               | Data-only if enabled | Own namespace only          | No                            |
| Bundled plugin  | Yes                       | Yes with manifest declaration    | Yes                  | Own namespace only          | Yes with manifest declaration |
| Core            | Yes                       | Yes                              | Yes                  | Any core state              | Yes                           |

Security requirements:

- Policy hooks that run before normal plugins must be bundled/trusted only.
- Plugin session patch actions must enforce gateway scopes.
- UI contributions must be declarative and sanitized.
- Plugin state projection must be explicit.
- Scheduler helpers must clean up by plugin id and session key.
- Disablement must remove privileged behavior immediately after restart.

## Backward Compatibility Notes

All changes should be additive:

- Existing plugins keep using `before_prompt_build`.
- Existing plugins keep using `before_tool_call`.
- Existing plugin commands keep current stop-after-command behavior.
- Existing session rows remain compatible.
- Existing Control UI behavior remains unchanged when no plugin contributes UI.
- Existing cron and heartbeat behavior remains unchanged when no plugin
  contributes scheduler state.

## Rollout Plan

1. Land the RFC PR.
2. File RFC issues for the six hook families.
3. Confirm maintainer decisions on open questions.
4. Land one hook implementation PR with fixture tests.
5. Build bundled Plan Mode plugin against the hooks.
6. Run parity audit against PR #71676.
7. Close or replace PR #71676 once the plugin port matches behavior.

## Filed RFC Issue Body Standard

The six GitHub issues are the authoritative decision threads. Each issue body
should stay self-contained and should not rely on PR comments for key context.
Each filed RFC issue should include:

- a clear warning that the APIs are proposed SDK surface, not implemented API
- the Plan Mode parity pressure from PR #71676
- the current SDK surface and why it is adjacent but insufficient
- the proposed host seam and at least one TypeScript-shaped API sketch
- reusable non-Plan plugin examples
- maintainer decisions needed before implementation
- fixture-plugin acceptance criteria
- links back to this RFC PR and PR #71676

Current filed issues:

| RFC | Issue                                                       | SDK primitive                                                             | Non-Plan examples emphasized                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A   | [#71732](https://github.com/openclaw/openclaw/issues/71732) | Plugin session extensions and patch actions                               | review gates, releases, memory managers, budgets, channel bindings, incidents                                      |
| B   | [#71733](https://github.com/openclaw/openclaw/issues/71733) | Durable next-turn injection queue and agent turn preparation              | review follow-ups, deployment checklists, memory hydration, incident handoffs, CI diagnostics, channel replies     |
| C   | [#71734](https://github.com/openclaw/openclaw/issues/71734) | Trusted tool policy and plugin tool metadata                              | budget guards, workspace policy, deployment freezes, dangerous-action wrappers, compliance labels, catalog plugins |
| D   | [#71735](https://github.com/openclaw/openclaw/issues/71735) | Scoped commands, trusted command ownership, and continuation              | deploy, review, budget, incident, memory, policy, and channel slash commands                                       |
| E   | [#71736](https://github.com/openclaw/openclaw/issues/71736) | Control UI contribution descriptors                                       | approval cards, release dashboards, budget warnings, memory panels, incident banners, channel auth cards           |
| F   | [#71737](https://github.com/openclaw/openclaw/issues/71737) | Agent events, run context, session scheduler, and heartbeat contributions | telemetry exporters, memory indexers, CI watchers, incident escalations, channel retries, long-running jobs        |

## Open Questions

1. Should Plan Mode be an always-bundled plugin or an opt-in bundled plugin?
2. Should Plan Mode command ownership be declared in the plugin manifest, at
   runtime, or both?
3. Should `update_plan` be decorated by plugins, or should Plan Mode own a
   parallel tool?
4. Should heartbeat prompt contributions be separate from generic turn
   preparation?
5. Should UI contribution descriptors be available from cold manifest metadata,
   runtime registry state, or both?
6. What is the minimum trust signal required for pre-plugin tool policy?
7. Should session extension state participate in transcript export or remain
   session-store only?
