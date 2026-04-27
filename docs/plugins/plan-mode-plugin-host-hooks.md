---
summary: "RFC bundle for the generic host hooks needed to make Plan Mode a first-class bundled plugin"
read_when:
  - Designing or reviewing Plan Mode as a bundled plugin
  - Adding plugin-owned session state, turn injections, tool policy, command continuation, or Control UI slots
  - Shrinking a large feature PR into generic host hooks plus plugin-owned behavior
title: "Plan Mode plugin host hooks"
sidebarTitle: "Plan Mode Hooks"
---

This page is the public index for the Plan Mode host-hook RFC work. The full
maintainer packet lives in
[Plan Mode Plugin Host Hooks RFC](/plan/plan-mode-plugin-host-hooks-rfc).

The RFC is based on PR #71676, "Plan Mode rebased onto upstream/main +
executing-state subsystem".

The design goal is to use PR #71676 as the behavior contract and parity oracle,
not as the merge target. This RFC defines the complete host-hook contract; the
follow-up implementation PR must implement all generic hooks needed before Plan
Mode can be packaged as a bundled plugin. The hook PR should be small,
additive, backwards-compatible, and covered by fixture-plugin tests.

<Warning>
  This page is an RFC proposal, not implemented SDK reference. The APIs and
  hooks named here are design targets for a future host-hook PR; they are not
  available on current `main`.
</Warning>

## Maintainer Packet

Read [the full RFC packet](/plan/plan-mode-plugin-host-hooks-rfc) for:

- current plugin surface gap analysis
- an "already implemented?" comparison that distinguishes adjacent existing
  hooks from the exact SDK contracts still missing
- current SDK research against existing hooks, using
  [#71427](https://github.com/openclaw/openclaw/issues/71427) as the comparison
  bar
- PR #71676 evidence by host entry point
- per-hook TypeScript-shaped contract proposals
- expected host files for each hook family
- security and trust-tier decisions
- fixture-plugin acceptance tests
- migration plan from PR #71676 to a bundled plugin
- copy-ready GitHub RFC issue bodies

Filed RFC issues:

| RFC | Issue                                                       | Topic                                                                       |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| A   | [#71732](https://github.com/openclaw/openclaw/issues/71732) | Plugin session extensions and patch actions                                 |
| B   | [#71733](https://github.com/openclaw/openclaw/issues/71733) | Durable next-turn injections and agent turn preparation hooks               |
| C   | [#71734](https://github.com/openclaw/openclaw/issues/71734) | Trusted tool policy stage and plugin tool metadata                          |
| D   | [#71735](https://github.com/openclaw/openclaw/issues/71735) | Scoped plugin commands, trusted command ownership, and continuation         |
| E   | [#71736](https://github.com/openclaw/openclaw/issues/71736) | Control UI plugin contribution slots                                        |
| F   | [#71737](https://github.com/openclaw/openclaw/issues/71737) | Agent events, run context, scheduler lifecycle, and heartbeat contributions |

## Summary

Make Plan Mode plugin-owned by adding a small set of generic host seams to
OpenClaw. The host PR should not merge Plan Mode behavior into core. It should
expose the runtime, session, command, UI, event, and scheduler hooks that let a
bundled plugin own the behavior without patching unrelated core files.

These hooks are SDK work first and Plan Mode enablement second. Plan Mode is
the large feature used to prove the seams, but the same contracts support other
bundled or external plugins that need durable session state, scoped commands,
trusted tool policy, UI descriptors, lifecycle cleanup, and safe runtime event
handling.

## Reusable Plugin Examples

| Plugin type                     | Hook families it can reuse                                                                                 | What the SDK hooks enable                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Human approval workflow         | Session extensions, patch actions, command continuation, UI approval descriptors, scheduler cleanup.       | Persist approvals, block sensitive tools, render approval cards, and resume the agent after a decision.       |
| Deployment and release workflow | Session state, next-turn injections, trusted tool policy, scoped commands, UI status, scheduler lifecycle. | Gate deploy tools, show rollout progress, continue after approval, and schedule smoke-test follow-ups.        |
| Cost or budget governor         | Session state, trusted policy, command scopes, UI warning descriptors, event subscriptions.                | Track spend, block expensive actions, expose scoped overrides, and warn users before continuing.              |
| Memory or context manager       | Session extensions, turn preparation, event subscriptions, run context, UI status.                         | Store plugin-owned context, inject selected memories once, update derived context, and show visibility state. |
| Review or CI gate               | Session state, tool policy, slash commands, UI cards, scheduler and event subscriptions.                   | Track findings or CI runs, block merge/deploy actions, rerun checks, and nudge stale reviews.                 |
| Incident or ticket bot          | Session state, next-turn injections, scoped commands, UI banners, scheduler lifecycle.                     | Track incidents, escalate on SLA timers, sync ticket actions, and inject handoff instructions.                |
| Channel integration             | Channel session state, command scopes, UI delivery descriptors, event subscriptions, scheduled retries.    | Bind Telegram/Slack/email threads, show delivery/auth state, and schedule retry or handoff behavior.          |
| Workspace policy plugin         | Session policy state, trusted tool policy, scoped commands, UI warnings, lifecycle cleanup.                | Enforce path/data rules before tools run, explain policy failures, and clear temporary grants on reset.       |

## Problem

PR #71676 proves the behavior, but it does so by embedding Plan Mode across
core entry points:

- session persistence and `sessions.patch`
- agent turn prompt preparation
- pending injection queues
- pre-tool mutation gates
- tool catalog and display metadata
- slash command continuation
- Control UI mode switcher and approval cards
- agent event persistence
- cron and heartbeat nudges

That makes Plan Mode hard to review, hard to shrink, and hard to maintain as a
plugin. A separate plugin port cannot reach full feature parity unless the host
first exposes the small number of missing seams.

## Goals

- Keep Plan Mode behavior plugin-owned.
- Keep core generic and plugin-id agnostic.
- Add only host seams that are required by PR #71676 behavior.
- Support durable session state and gateway projection without ad hoc root
  session fields.
- Support exactly-once next-turn injections without plugins rewriting prompt
  assembly.
- Support host-owned pre-tool policy ordering that cannot be bypassed by normal
  plugin hooks.
- Support data-driven Control UI contributions for chat modes and approval
  surfaces.
- Support command handlers that can patch state and resume the agent.
- Provide fixture-plugin tests for each new seam before porting Plan Mode.

## Non Goals

- Do not merge Plan Mode itself in the host hook PR.
- Do not add Plan Mode-specific ids, schemas, or vocabulary to core.
- Do not make external plugins fully trusted by default.
- Do not expand broad SDK barrels when a narrow contract is enough.
- Do not rely on local installer patches as the long-term plugin contract.

## Current Patch Evidence

The following PR #71676 areas show where the host currently needs generic
hooks. Paths are repo-root relative as they appear in the #71676 branch/diff;
some are intentionally absent from current `main` because #71676 is the parity
oracle, not code to cherry-pick.

| Behavior                                          | PR #71676 core touch points                                                                                                                            | Missing generic seam                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Durable approval and plan state                   | `src/config/sessions/types.ts`, `src/gateway/protocol/schema/sessions.ts`, `src/gateway/sessions-patch.ts`, `src/gateway/session-utils.ts`             | Plugin session extension and plugin patch actions                     |
| Approval, revision, nudge, and question injection | `src/auto-reply/reply/agent-runner-execution.ts`, `src/agents/pi-embedded-runner/pending-injection.ts`, `src/agents/pi-embedded-runner/run/attempt.ts` | Durable next-turn injection queue                                     |
| Mutation blocking before approval                 | `src/agents/pi-tools.before-tool-call.ts`, `src/agents/pi-tools.ts`                                                                                    | Pre-plugin tool policy gate                                           |
| Plan tools and display                            | `src/agents/openclaw-tools.ts`, `src/agents/tool-catalog.ts`, `src/agents/tool-display-config.ts`, Control UI tool display JSON                        | Plugin tool catalog and display metadata                              |
| `/plan` command flow                              | `src/auto-reply/reply/commands-plan.ts`, `src/auto-reply/reply/commands-plugin.ts`, `src/plugins/command-registration.ts`                              | Scoped command continuation and trusted command ownership             |
| Approval cards and mode switcher                  | `ui/src/ui/chat/mode-switcher.ts`, `ui/src/ui/app-tool-stream.ts`, `ui/src/ui/app-render.ts`, `ui/src/ui/views/plan-approval-inline.ts`                | Control UI plugin contribution slots                                  |
| Plan snapshots and subagent state                 | `src/infra/agent-events.ts`, `src/gateway/plan-snapshot-persister.ts`, `src/gateway/server-runtime-subscriptions.ts`                                   | Agent event subscriptions plus run context extensions                 |
| Auto nudges and heartbeats                        | `src/infra/heartbeat-runner.ts`, `src/cron/*`                                                                                                          | Session-scoped scheduler lifecycle plus heartbeat prompt contribution |

## RFC A: Plugin Session Extensions

### Session Contract

Add a plugin registration surface:

```ts
api.registerSessionExtension({
  key: "example",
  schema,
  publicProjection,
  patchActions,
  lifecycle,
});
```

The registered extension owns a namespaced session state blob. Core persists it,
validates patch actions, projects safe fields to gateway clients, and resets it
through documented lifecycle hooks.

### Session Host Work

- Add a generic `session.extensions.<pluginKey>` store.
- Add schema-backed validation for extension patch payloads.
- Add gateway patch routing, for example `sessions.pluginPatch`, or an additive
  `sessions.patch.plugin` envelope.
- Broadcast normal session-change events after plugin patch actions.
- Include public projection in session list/detail rows.
- Add lifecycle points for reset, close, delete, compaction, and migration.

### Session Plan Mode Uses

Plan Mode would store approval mode, cycle id, title, summary, last plan steps,
pending question, pending injection ids, auto-approve settings, blocking
subagent ids, and nudge job ids under its own extension key.

### Session Acceptance Tests

- A fixture plugin registers a session extension and patches it through gateway
  RPC.
- Invalid patch payloads fail closed with a stable error code.
- Public projection appears in session rows without leaking private fields.
- Reset/delete lifecycle clears extension state and related scheduled work.

## RFC B: Agent Turn Preparation And Injection

### Turn Contract

Add a durable agent-turn preparation seam:

```ts
api.enqueueNextTurnInjection({
  sessionKey,
  id,
  role: "user",
  content,
  reason,
});

api.on("agent_turn_prepare", async (event, ctx) => {
  return {
    prependSystemContext,
    prependUserMessages,
  };
});
```

The host owns dequeue timing and exactly-once semantics. Plugins may enqueue
future-turn injections, but the runner decides when to consume them.

### Turn Host Work

- Drain pending plugin injections once before agent retry/fallback loops.
- Preserve the injected content through prompt assembly and provider transforms.
- Mark consumed injections transactionally so retries do not duplicate them.
- Include session extension state and current run metadata in hook context.
- Keep existing `before_prompt_build` compatibility intact.

### Turn Plan Mode Uses

Plan Mode would enqueue approved-plan execution instructions, revise-plan
instructions, question answers, scheduled nudges, and subagent follow-up
prompts without patching `agent-runner-execution.ts` or runner internals.

### Turn Acceptance Tests

- A fixture plugin enqueues an injection and the next agent run receives it
  exactly once.
- Retry/fallback does not duplicate the injection.
- Existing `before_prompt_build` output still applies in deterministic order.

## RFC C: Tool Policy And Tool Metadata

### Tool Contract

Add a trusted tool policy surface separate from normal `before_tool_call`:

```ts
api.registerToolPolicy({
  id: "example.policy",
  trust: "bundled",
  stage: "pre_plugin_hooks",
  handler,
});
```

Also let plugin-owned tools publish catalog and display metadata:

```ts
api.registerToolMetadata({
  name,
  title,
  category,
  safety,
  display,
});
```

### Tool Host Work

- Run trusted policy gates before normal plugin `before_tool_call` hooks.
- Keep normal `before_tool_call` terminal block behavior unchanged.
- Make policy registration available only to bundled/trusted plugins unless a
  future trust model says otherwise.
- Add tool display metadata lookup for plugin-owned tools.
- Add a generic way for plugins to extend or decorate built-in tool contracts
  when core owns the base tool.

### Tool Plan Mode Uses

Plan Mode would block mutating tools while a plan is pending approval, expose
`enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, and
`plan_mode_status`, and decorate `update_plan` behavior without hardcoding Plan
Mode in the core tool catalog.

### Tool Acceptance Tests

- A fixture policy blocks a mutating tool before a normal `before_tool_call`
  hook can alter the call.
- A fixture plugin tool appears with registered display metadata.
- Existing `before_tool_call` tests keep passing.

## RFC D: Commands, Scopes, And Agent Continuation

### Command Contract

Extend plugin command definitions:

```ts
api.registerCommand({
  name: "example",
  requiredScopes: ["operator.approvals"],
  ownership: "trusted-core-command",
  handler,
});
```

Extend command results:

```ts
return {
  message: "Accepted.",
  continueAgent: true,
};
```

### Command Host Work

- Add declarative command `requiredScopes`.
- Add command result `continueAgent`.
- Preserve current command behavior when `continueAgent` is absent.
- Add a trusted ownership path for bundled plugins to claim command roots that
  otherwise look core-reserved.
- Keep external plugin command names isolated by default.

### Command Plan Mode Uses

Plan Mode would own `/plan`, `/plan status`, `/plan accept`, `/plan revise`,
`/plan answer`, and auto mode toggles. Mutating commands would require approval
scope and then continue the agent when appropriate.

### Command Acceptance Tests

- A fixture command requiring `operator.approvals` rejects callers without that
  scope.
- A fixture command returning `continueAgent: true` resumes the agent.
- Existing plugin commands still default to no continuation.

## RFC E: Control UI Plugin Contribution Slots

### UI Contract

Expose data-driven UI contribution metadata through the gateway plugin
registry. Initial slots:

- chat mode entries
- approval card renderers
- tool/event stream classifiers
- chat input guards
- sidebar or inline status panels

Example manifest or runtime projection:

```ts
api.registerControlUiContribution({
  chatModes: [...],
  approvalRenderers: [...],
  eventClassifiers: [...],
  inputGuards: [...],
});
```

The initial renderer model should prefer declarative data and existing safe UI
components over arbitrary plugin JavaScript in the browser.

### UI Host Work

- Add gateway projection for enabled plugin UI contributions.
- Add Control UI registries for chat modes and approval cards.
- Add a safe event classifier boundary for plugin-owned approval payloads.
- Add an input guard result that can disable or annotate the composer.
- Keep CSS classes and layout tokens host-owned where possible.

### UI Plan Mode Uses

Plan Mode would add Plan and Plan Auto mode entries, render approval/question
cards, classify plugin approval events, show mode/status hints, and block chat
input when waiting on an approval response if the product wants that behavior.

### UI Acceptance Tests

- A fixture plugin contributes a chat mode entry visible in the mode switcher.
- A fixture plugin approval payload renders through the registered card slot.
- Removing or disabling the plugin removes its UI contributions.

## RFC F: Agent Events, Run Context, And Scheduler Lifecycle

### Event And Scheduler Contract

Expose safe agent event subscriptions and run-context storage:

```ts
api.onAgentEvent("tool_result", handler);
ctx.runContext.set(runId, "example", value);
ctx.runContext.get(runId, "example");
```

Add scheduler lifecycle helpers tied to session extension state:

```ts
ctx.scheduler.createSessionJob(...);
ctx.scheduler.deleteSessionJobs({ sessionKey, pluginKey });
```

Add a heartbeat prompt contribution hook:

```ts
api.on("heartbeat_prompt_contribution", handler);
```

### Event And Scheduler Host Work

- Expose agent events without leaking mutable internal event bus references.
- Provide run-scoped plugin data that is cleaned up when the run completes.
- Let session extension lifecycle clean up cron or heartbeat jobs.
- Let heartbeat prompt assembly ask enabled plugins for additive prompt text.
- Keep existing `gateway_start.getCron` behavior for lower-level cron access.

### Event And Scheduler Plan Mode Uses

Plan Mode would persist plan snapshots, track blocking subagent ids, clear
approval state after run completion, attach nudge jobs to sessions, and add
heartbeat prompt nudges from plugin-owned state.

### Event And Scheduler Acceptance Tests

- A fixture plugin observes an agent event and persists derived session state.
- Run-context data is unavailable after run cleanup.
- Session reset deletes fixture scheduler jobs.
- A fixture heartbeat contribution appears only when its session extension
  state requests it.

## One Hook PR Shape

The follow-up hook PR should be one focused host PR with these commits:

1. Session extension registry, gateway patch action plumbing, and tests.
2. Agent turn injection queue and `agent_turn_prepare` hook, with tests.
3. Trusted tool policy gate and tool metadata registry, with tests.
4. Command scopes, trusted command ownership, and `continueAgent`, with tests.
5. Control UI contribution projection and minimal renderer slots, with tests.
6. Agent event, run-context, and scheduler lifecycle helpers, with tests.
7. Documentation and a fixture plugin that exercises all new seams.

Plan Mode plugin code should not be included. The fixture plugin should be tiny
and intentionally non-product so reviewers can evaluate the seams without
reviewing Plan Mode behavior.

## SDK Contract Fixture Requirements

The fixture plugin should prove the full path without Plan Mode product logic.
It should model reusable SDK consumers such as an approval workflow, a
budget/workspace policy gate, and a background lifecycle plugin:

- registers a session extension
- patches extension state through gateway RPC
- projects public state to the UI
- enqueues a next-turn injection
- blocks a tool through pre-plugin policy
- registers a plugin-owned tool with display metadata
- registers a scoped command that can continue the agent
- contributes one chat mode and one approval card
- observes one agent event and writes derived state
- creates and cleans up one session-scoped scheduled job

## Migration Plan For Plan Mode

1. Land the host hook PR with fixture tests.
2. Build Plan Mode as a bundled plugin against the new seams.
3. Use PR #71676 as the feature-by-feature parity oracle.
4. Port behavior by surface, not by file:
   - session state and patch actions
   - tools and tool policy
   - agent turn injections
   - commands and continuation
   - UI contributions
   - event persistence
   - scheduler nudges
5. Delete host patches that become unnecessary.
6. Run parity tests against the original PR behavior before requesting merge.

## Review Checklist

- No Plan Mode-specific ids or fields are added to core.
- Public SDK changes are additive and documented.
- External plugins cannot register trusted policy gates unless explicitly
  allowed by the trust model.
- Session extension state validates all external payloads.
- Gateway protocol changes are additive.
- UI contributions are disabled when the owning plugin is disabled.
- Prompt and injection ordering is deterministic.
- Existing plugin hook behavior remains compatible.
- Fixture tests cover every new seam.

## Open Questions

- Should plugin session patch actions live under `sessions.patch` or a separate
  `sessions.pluginPatch` gateway method?
- Should trusted command ownership be manifest-declared, runtime-declared, or
  both?
- Should Control UI plugin contributions be manifest-only for cold discovery,
  runtime-projected after gateway startup, or a two-phase model?
- Should `update_plan` become explicitly extensible, or should Plan Mode own a
  parallel tool and treat `update_plan` as ordinary planning telemetry?
- Should heartbeat prompt contributions be a separate hook or a specialized
  case of `agent_turn_prepare`?
