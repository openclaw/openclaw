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

## Maintainer Decision To Make

The decision is not "merge PR #71676 or reject Plan Mode." The useful decision
is:

> Which host seams must OpenClaw expose so Plan Mode can be implemented as a
> first-class bundled plugin without reversible installer patches or scattered
> core edits?

The proposed answer is six hook families:

| RFC | Hook family                                                  | Required before Plan Mode plugin parity? | Why                                                                                            |
| --- | ------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A   | Plugin session extensions and patch actions                  | Yes                                      | Plan Mode is fundamentally durable per-session state.                                          |
| B   | Durable next-turn injections and agent turn preparation      | Yes                                      | Approvals, revisions, question answers, and nudges must feed the next run exactly once.        |
| C   | Trusted tool policy and plugin tool metadata                 | Yes                                      | Mutation blocking must run before ordinary tool hooks; plugin tools need first-class metadata. |
| D   | Scoped plugin commands and command continuation              | Yes                                      | `/plan accept` and related commands must mutate state and resume execution.                    |
| E   | Control UI contribution slots                                | Yes for first-class UX                   | Plan/Plan Auto mode, approval cards, and input guards must not patch UI files.                 |
| F   | Agent event, run context, scheduler, and heartbeat lifecycle | Yes for full parity                      | Snapshot persistence, subagent gates, nudges, and lifecycle cleanup depend on runtime events.  |

The hook PR should implement those seams with a tiny fixture plugin. The Plan
Mode plugin should come after the hook PR and use PR #71676 as its parity
oracle.

## Why A Plugin-Only Port Is Not Enough

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
host code. That breadth is the evidence for the missing seams.

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
  | { allow?: true }
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

### RFC F Fixture Tests

Required fixture coverage:

- Fixture plugin receives a safe agent event.
- Fixture plugin writes derived session extension state from an event.
- Run context data is available during a run and cleaned after completion.
- Session reset deletes fixture-owned scheduled jobs.
- Heartbeat contribution appears only when extension state requests it.

## One Host-Hook PR Implementation Plan

The implementation PR should be small relative to PR #71676 and should avoid
Plan Mode feature logic. Recommended commit stack:

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

## Fixture Plugin Contract

Create a fixture plugin with no product behavior. Suggested id:
`host-hook-fixture`.

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

The fixture plugin is the guardrail that future Plan Mode work depends on.

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

## Copy-Ready RFC Issue Packet

### Issue A Title

`[RFC] Plugin session extensions and patch actions`

### Issue A Body

Summary:

Add a namespaced plugin session extension API so bundled plugins can persist
typed per-session state, expose an explicit public projection to gateway/UI
clients, and mutate that state through gateway-authorized patch actions.

Problem:

Plan Mode currently requires root `SessionEntry` fields and hardcoded
`sessions.patch` behavior. A first-class plugin needs the same durability,
validation, projection, broadcast, and lifecycle behavior without Plan
Mode-specific core fields.

Required decisions:

- `sessions.pluginPatch` method vs `sessions.patch.plugin` envelope
- public projection shape
- lifecycle hooks for reset/delete/compaction/migration
- stable error codes

Acceptance:

- fixture plugin can persist extension state
- invalid payload fails closed
- projection appears in session rows
- private fields do not leak
- reset/delete cleans extension state

### Issue B Title

`[RFC] Durable next-turn injections and agent turn preparation hooks`

### Issue B Body

Summary:

Add a host-owned queue for plugin next-turn injections plus an
`agent_turn_prepare` hook so plugins can schedule future prompt additions with
exactly-once semantics.

Problem:

Plan Mode approval acceptance, revision, question answering, nudges, and
subagent follow-ups must affect a future run exactly once. `before_prompt_build`
is not durable enough and should not be used as a pending interaction queue.

Required decisions:

- storage location for pending injections
- dequeue timing relative to retries and provider transforms
- prompt ordering relative to `before_prompt_build`
- expiry and dedupe behavior

Acceptance:

- fixture injection reaches next run once
- retry/fallback does not duplicate it
- expired injection is discarded
- plugin disablement suppresses injections

### Issue C Title

`[RFC] Trusted tool policy stage and plugin tool metadata`

### Issue C Body

Summary:

Add a trusted pre-plugin tool policy stage and plugin-owned tool metadata so
bundled plugins can enforce host-level policy and display first-class tool UI.

Problem:

Plan Mode must block mutating tools before normal plugin `before_tool_call`
hooks. Plan Mode tools also need catalog/display/safety metadata without core
tool catalog patches.

Required decisions:

- trust tier for pre-plugin policy hooks
- policy decision shape
- plugin tool display metadata schema
- whether core-owned tools such as `update_plan` can be decorated

Acceptance:

- fixture policy blocks before normal hooks
- normal plugin cannot override trusted block
- external plugin cannot register trusted policy
- fixture tool metadata appears in UI/tool display lookup

### Issue D Title

`[RFC] Scoped plugin commands, trusted command ownership, and continuation`

### Issue D Body

Summary:

Extend plugin commands with declarative gateway scopes, trusted command-root
ownership, and a `continueAgent` result for commands that should resume an
agent run after handling.

Problem:

Plan Mode `/plan accept`, `/plan revise`, and `/plan answer` must patch state,
enqueue a continuation, and resume the agent. Current plugin commands do not
declare required scopes and default to stopping.

Required decisions:

- command scope declaration shape
- reserved command ownership model
- `continueAgent` result semantics
- command discovery before plugin runtime activation

Acceptance:

- fixture command enforces `operator.approvals`
- read-only command works with read scope
- `continueAgent: true` resumes execution
- existing commands preserve current behavior

### Issue E Title

`[RFC] Control UI plugin contribution slots`

### Issue E Body

Summary:

Add data-driven Control UI contribution slots for plugin chat modes, approval
cards, event classifiers, input guards, and status surfaces.

Problem:

Plan Mode should not patch `mode-switcher`, `app-tool-stream`, `app-render`, or
custom CSS to become visible in the web UI. A first-class plugin needs UI
contribution descriptors exposed by the gateway.

Required decisions:

- manifest vs runtime contribution projection
- initial component catalog
- event classifier descriptor shape
- input guard behavior
- disablement semantics

Acceptance:

- fixture chat mode appears only when plugin is enabled
- fixture approval payload renders through generic card slot
- fixture action sends plugin patch action
- input guard reflects projected plugin session state

### Issue F Title

`[RFC] Agent event subscriptions, run context, scheduler lifecycle, and heartbeat contributions`

### Issue F Body

Summary:

Expose safe plugin subscriptions to agent events, run-scoped plugin context,
session-scoped scheduler helpers, and heartbeat prompt contributions.

Problem:

Plan Mode parity requires plan snapshot persistence, subagent tracking, run
completion cleanup, scheduled nudges, and heartbeat prompt nudges. Plugins need
stable helpers for those behaviors without raw event-bus access.

Required decisions:

- event types exposed to plugins
- run-context storage lifecycle
- session-scoped scheduler ownership model
- dedicated heartbeat hook vs `agent_turn_prepare`

Acceptance:

- fixture plugin observes one agent event
- fixture plugin writes derived extension state
- run context is cleaned after completion
- session reset deletes fixture jobs
- heartbeat contribution appears only when state requests it

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
