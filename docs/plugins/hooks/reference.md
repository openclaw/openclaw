---
summary: "How plugin hooks register and execute, plus the complete typed hook catalog"
read_when:
  - You are wiring a typed handler and need the ordering, timeout, and failure rules
  - You want to know which typed hook exists for a surface
  - You are registering a Skill Workshop evaluator or a pairing observer
title: "Hook reference"
sidebarTitle: "Hook reference"
---

Registration rules, execution contracts, per-handler budgets, and the
complete typed hook catalog. Part of the [Plugin hooks](/plugins/hooks) guide.

## Registration and execution

Keep `register(api)` synchronous and register handlers there. The handlers
themselves may be asynchronous except for the two synchronous persistence hooks.

Handlers default to priority `0`; higher priorities run first, with registration
order breaking ties. Execution depends on the hook kind:

| Kind             | Execution contract                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modify           | Sequential; results merge according to the hook's contract below. Returning a rewrite does not generally change the event passed to later handlers. |
| Claim            | Sequential; the first `{ handled: true }` wins and skips remaining handlers.                                                                        |
| Gate             | Sequential; a block stops remaining handlers.                                                                                                       |
| Observe          | Handlers run concurrently; return values are ignored. The emitter may await completion or dispatch fire-and-forget.                                 |
| Sync modify/gate | Synchronous, in priority order; each handler sees the latest message. Promises are ignored with a warning.                                          |
| Evaluate         | Skill evaluators run concurrently and produce separate attributed outcomes.                                                                         |

Priority does not serialize observation side effects. Fire-and-forget events
can overlap later events, and callbacks are not a durable event queue. Return
modifications explicitly instead of relying on in-place mutation.

`api.on(name, handler, opts?)` accepts:

| Option                  | Effect                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `matcher`               | Non-empty list of canonical OpenClaw tool ids handled by `before_tool_call` or `after_tool_call`, such as `exec`, `apply_patch`, or `spawn_agent`. Omit to match all tools. Empty lists, wildcards, blanks, and provider-specific aliases are invalid. |
| `priority`              | Ordering; higher runs first.                                                                                                                                                                                                                           |
| `registrationId`        | Stable identity for one registration inside a plugin. Skill evaluators use it as `evaluatorId`; otherwise the plugin id is used.                                                                                                                       |
| `timeoutMs`             | Per-handler asynchronous await budget. Expiry applies the hook's failure policy below; it does not cancel the handler or its side effects. Omit to use the runner's default, if any.                                                                   |
| `eligibleTriggers`      | For `before_agent_reply` only, limits host dispatch to one or more of `cron`, `heartbeat`, or `user`.                                                                                                                                                  |
| `eligibleDispatchKinds` | For `reply_dispatch` only, limits host dispatch to `agent`, `acp`, or both. Omit to handle all dispatch kinds.                                                                                                                                         |
| `requiresToolAuthority` | For `before_prompt_build` only, runs the handler after the host finalizes the current turn's tool surface and supplies ephemeral `ctx.toolAuthority`. Use this for context retrieval that must follow tool policy.                                     |

Trigger eligibility is enforced by the host before it invokes the handler. A
hook registered with `eligibleTriggers: ["heartbeat", "cron"]` is therefore
inactive for user turns, including a recovered user turn. Omitted, empty,
malformed, or partly unknown lists remain unrestricted, so the hook runs for
those turns. Other hook kinds do not accept this option.

Operators can set hook budgets without patching plugin code:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "timeoutMs": 30000,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        }
      }
    }
  }
}
```

`hooks.timeouts.<hookName>` overrides `hooks.timeoutMs`, which overrides the
plugin-authored `api.on(..., { timeoutMs })` value. The two operator config
fields accept positive integers up to 600000 ms. Prefer per-hook overrides for
known-slow hooks so one plugin does not get a longer budget everywhere.

A timed-out handler promise continues running because hook callbacks do not
receive a timeout-owned cancellation signal. `before_tool_call` may receive the
owning tool call's `ctx.abortSignal`, but hook timeout expiry does not abort it.
The hook dispatch can release its Gateway admission while that plugin work is
still in progress. Plugins that own long-running work must provide their own
cancellation and shutdown lifecycle.

The standard runner applies these defaults **per handler**:

| Hooks                                                                                                          | Default timeout                     | On thrown error or timeout                                       |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `before_agent_run`, `before_tool_call`, `before_install`                                                       | 15 seconds                          | Fail closed: block the run, tool call, or install                |
| `before_agent_finalize`, `before_prompt_build`, `message_sending`, `reply_payload_sending`, `resolve_exec_env` | 15 seconds                          | Log and skip the failed handler; retain other successful results |
| `agent_end`, `before_compaction`, `after_compaction`, `skill_changed`, `skill_proposal_changed`                | 30 seconds                          | Log and continue                                                 |
| `channel_pairing_requested`                                                                                    | 2 seconds                           | Log and continue                                                 |
| `gateway_stop`                                                                                                 | 5 seconds                           | Log and continue shutdown                                        |
| `skill_proposal_evaluate`                                                                                      | 120 seconds                         | Record an attributed error outcome                               |
| Other asynchronous hooks, including claim hooks                                                                | No runner timeout unless configured | Log and continue                                                 |
| `tool_result_persist`, `before_message_write`                                                                  | No asynchronous timeout             | Synchronous errors are logged; failed results are ignored        |

An emitter can impose a tighter overall lifecycle budget, such as the
shutdown `session_end` drain below. A timeout only bounds an asynchronous
await; it cannot interrupt synchronous JavaScript. For a policy requirement,
use a fail-closed gate rather than assuming an observation or delivery hook
will reject the operation on failure.

For claim hooks, continuing means trying the next handler. The caller decides
what happens if nobody claims; a failed `inbound_claim` for a bound
conversation can produce a binding notice instead of an ordinary agent reply.

Channel plugins that use `createReplyDispatcher` can likewise declare a larger
positive per-stage budget with `beforeDeliverOptions: { timeoutMs }`, or when
appending work with `dispatcher.appendBeforeDeliver(handler, { timeoutMs })`.
Without an owner-declared budget, those callbacks use the same 15-second
default so a hung callback cannot retain the serialized delivery lane.

## Hook catalog

Hooks are grouped by the surface they extend. Kinds refer to the execution
contracts above; a modifying hook is not an observation hook.

**Agent turn**

| Hook                            | Kind    | Purpose                                                                                                     |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `before_model_resolve`          | Modify  | Override provider or model before session messages load                                                     |
| `agent_turn_prepare`            | Modify  | Inspect drained plugin turn injections and add context before prompt hooks                                  |
| `before_prompt_build`           | Modify  | Add prompt context, narrow the current turn's submitted tools, or perform authorized post-policy enrichment |
| `before_agent_run`              | Gate    | Inspect the final prompt and session messages before model submission; can block the run                    |
| `before_agent_reply`            | Claim   | Short-circuit the model turn with a synthetic reply or silence                                              |
| `before_agent_finalize`         | Modify  | Inspect the natural final answer and request one more model pass                                            |
| `agent_end`                     | Observe | Observe final messages, success state, and run duration                                                     |
| `heartbeat_prompt_contribution` | Modify  | Add heartbeat-only context for background monitor and lifecycle plugins                                     |

**Conversation observation**

| Hook                                      | Kind    | Purpose                                                                                                            |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `model_call_started` / `model_call_ended` | Observe | Sanitized provider/model call metadata: timing, outcome, bounded request-id hashes. No prompt or response content. |
| `llm_input`                               | Observe | Provider input: system prompt, prompt, history                                                                     |
| `llm_output`                              | Observe | Provider output, usage, and the resolved `contextTokenBudget` when available                                       |

**Tools**

| Hook                   | Kind               | Purpose                                                    |
| ---------------------- | ------------------ | ---------------------------------------------------------- |
| `before_tool_call`     | Modify / gate      | Rewrite tool params, block execution, or require approval  |
| `after_tool_call`      | Observe            | Observe tool results, errors, and duration                 |
| `resolve_exec_env`     | Modify             | Contribute plugin-owned environment variables to `exec`    |
| `tool_result_persist`  | Sync modify        | Rewrite a toolResult message before transcript persistence |
| `before_message_write` | Sync modify / gate | Rewrite or block a message before transcript persistence   |

**Messages and delivery**

| Hook                        | Kind          | Purpose                                                                    |
| --------------------------- | ------------- | -------------------------------------------------------------------------- |
| `inbound_claim`             | Claim         | Claim an inbound message for the plugin that owns its conversation binding |
| `channel_pairing_requested` | Observe       | Observe newly created DM pairing requests                                  |
| `message_received`          | Observe       | Observe inbound content, sender, thread, and metadata                      |
| `message_sending`           | Modify / gate | Rewrite outbound content or cancel delivery                                |
| `reply_payload_sending`     | Modify / gate | Mutate or cancel normalized reply payloads before delivery                 |
| `message_sent`              | Observe       | Observe outbound delivery success or failure                               |
| `before_dispatch`           | Claim         | Handle an inbound message before the normal model dispatch                 |
| `reply_dispatch`            | Claim         | Own reply generation and dispatch instead of the default model path        |

`inbound_claim` is not a global pre-routing broadcast. OpenClaw invokes it only
for the plugin that owns the message's core-managed conversation binding. To
suppress an ordinary agent turn before model input without retaining the
original prompt in transcript, use `before_agent_run` on a supported runner.
To short-circuit an agent turn with a synthetic reply or silence, use
`before_agent_reply`.

**Sessions and compaction**

| Hook                                     | Kind    | Purpose                                                      |
| ---------------------------------------- | ------- | ------------------------------------------------------------ |
| `session_start` / `session_end`          | Observe | Track session lifecycle boundaries                           |
| `before_compaction` / `after_compaction` | Observe | Observe compaction boundaries; no rewrite or veto result     |
| `before_reset`                           | Observe | Observe session-reset events (`/reset`, programmatic resets) |

Successful engine-owned compaction attempts emit `after_compaction` even when
no history changes, with `compactedCount: 0`. Failed or aborted attempts do not
emit that completion hook.

`session_end.reason` is one of `new`, `reset`, `idle`, `daily`, `compaction`,
`deleted`, `shutdown`, `restart`, or `unknown`. `session_start` has no reason
field; it can include `resumedFrom`. Shutdown/restart events come from the
Gateway finalizer for active sessions, so plugins can close session state
before the process exits.

Shutdown and restart share one **2-second total `session_end` drain budget**
across all active sessions and plugin handlers; the budget is not per handler.
Return quickly or keep finalization bounded and persistence crash-consistent.
If the budget expires, OpenClaw logs `shutdown session-end drain timed out`
and continues shutdown, so unfinished plugin work can be interrupted.

For `sessions.create` calls with `parentSessionKey` and `emitCommandHooks: true`, a distinct child always receives `session_start`. Callers declare whether the parent also receives terminal `session_end` with `succeedsParent`: `true` means successor, `false` means parallel child. Omission preserves the legacy parent-rollover behavior. The `command:new` and `before_reset` hooks still describe the requested `/new` action in both cases.

**Subagents**

- `subagent_spawned` / `subagent_ended` - observe subagent launch and completion.
- `subagent_progress` - observe portable `started` / `ended` progress for a background child run; includes `runId`, `childSessionKey`, optional requester route, and an outcome on `ended`.
- `subagent_delivery_target` - modifying compatibility hook for completion delivery when no core session binding can project a route. The first returned `origin` wins.
- `subagent_spawned` includes `resolvedModel` and `resolvedProvider` when OpenClaw has resolved the child session's native model before launch.
- `subagent_ended` carries `targetSessionKey` (identity - matches `subagent_spawned.childSessionKey`), `targetKind` (`"subagent"` or `"acp"`), `reason`, optional `outcome` (`"ok"`, `"error"`, `"timeout"`, `"killed"`, `"reset"`, or `"deleted"`), optional `error`, `runId`, `endedAt`, `accountId`, and `sendFarewell`. It does **not** include `agentId` or `childSessionKey`; use `targetSessionKey` to correlate with the matching `subagent_spawned` event.

**Lifecycle**

| Hook                             | Kind          | Purpose                                                                                              |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `gateway_start` / `gateway_stop` | Observe       | Start or stop plugin-owned services with the Gateway                                                 |
| `cron_reconciled`                | Observe       | Reconcile against the complete Gateway cron state after startup or reload                            |
| `cron_changed`                   | Observe       | Observe Gateway-owned cron lifecycle changes (added, updated, removed, started, finished, scheduled) |
| `before_install`                 | Modify / gate | Inspect staged skill or plugin install material from a loaded plugin runtime                         |
| `skill_proposal_evaluate`        | Evaluate      | Evaluate one exact Skill Workshop draft and return attributed findings, metrics, or a decision       |
| `skill_proposal_changed`         | Observe       | Observe durable Skill Workshop proposal lifecycle events after they commit                           |
| `skill_changed`                  | Observe       | Observe committed live-skill create, update, and removal events                                      |

### Skill lifecycle and evaluation

Use `skill_proposal_evaluate` for static analyzers, security scanners,
benchmarks, model-based graders, or other third-party evaluators. OpenClaw
passes an immutable candidate bundle with file hashes and a tree hash. Update
proposals also include the complete current skill as `baseline`. Text files use
UTF-8 content; binary files use base64.

Evaluator registrations run concurrently. Give each evaluator a stable
`registrationId`:

```typescript
api.on(
  "skill_proposal_evaluate",
  async (event) => {
    const score = await evaluateBundle(event.candidate, event.baseline);
    return {
      evaluatorVersion: "rules-2026-07",
      mode: "baseline-comparison",
      decision: score.regressed ? "revise" : "pass",
      summary: score.summary,
      metrics: score.metrics,
      findings: score.findings,
    };
  },
  { registrationId: "quality-regression", timeoutMs: 90_000 },
);
```

When evaluation input includes `correlationId`, OpenClaw forwards it to the
evaluator event for both manual and apply-triggered evaluations. This value is
caller-supplied correlation metadata, not authenticated identity or proof of
authorization. An authorization plugin must mint or replace the value through
a trusted entry point, bind it to the intended operation, and validate and
consume it itself.

Stored outcomes identify the evaluator, plugin id, plugin package version,
status, and returned result. Timeouts and thrown errors are recorded as
attributed error outcomes; they do not fail the whole evaluation. Among
evaluator outcomes, only a completed `decision: "block"` vetoes apply. Other
Workshop validation and ownership checks still apply. Apply revalidates the
evaluated target tree under the Workshop mutation lock, so any live skill asset
drift requires reevaluation.
The complete persisted evaluation envelope is capped at 512 KiB.

`skill_proposal_changed` fires after the matching proposal row and append-only
lifecycle event commit. It carries the event id, sequence, exact proposal
revision hash, optional correlation id, and evaluation outcomes.
`skill_changed` fires after a live skill create, update, or removal commits and
includes optional before/after artifacts with content and tree hashes, plus
declared and source versions when available.

These hooks are primitives, not an optimization scheduler. A plugin or external
controller can observe a durable proposal event, evaluate its exact revision hash,
revise with that hash and a correlation id, then repeat. OpenClaw does not
automatically revise proposals or run an unbounded evaluation loop.
Event replay is byte-bounded and returns `nextSequence` when another page is
available.

### Channel pairing requests

Use `channel_pairing_requested` when a plugin needs to notify an operator or
write an audit record after an unpaired DM sender creates a pending pairing
request. The hook is dispatched when the request is created; channel delivery of
the pairing reply is not delayed by slow or failing hook handlers.

```typescript
api.on("channel_pairing_requested", async (event) => {
  await notifyOperator({
    text: `New ${event.channel} pairing request from ${event.senderId}: ${event.code}`,
  });
});
```

The hook is observation-only. It does not approve, reject, suppress, or rewrite
the pairing reply. The payload includes the channel, optional `accountId`,
channel-scoped `senderId`, pairing `code`, and channel metadata. Treat the
pairing code as a live single-use approval credential and deliver it only to a
trusted operator sink. Treat `metadata` as untrusted sender-supplied identity
text. The hook does not include the inbound message body or media.
