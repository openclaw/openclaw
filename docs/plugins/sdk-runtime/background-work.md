---
doc-schema-version: 1
summary: "Hook agent turns and subagent runs"
read_when:
  - You are dispatching an agent turn for untrusted external content
  - You are launching or waiting on a background subagent run
title: "Plugin runtime background work"
sidebarTitle: "Background work"
---

Start agent work in the background: hook-dispatched turns for external content and subagent runs. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

## Requester-bound native children

Use optional `api.runtime.subagent.native` inside an eligible `reply_dispatch` handler when a plugin controller needs the same native children as `sessions_spawn`, rather than a separate agent turn. The Gateway supplies the actual current request; plugins cannot choose a parent session, requester, credentials, or permission scope.

`spawn` returns native accepted IDs and always uses collector completion. Reuse a nonempty `requestId` within the same plugin and parent turn to replay the same request. Reusing it with different arguments fails instead of creating another child. Normal tool hooks still run; incompatible rewrites of the native runtime, run mode, collector completion, or replay identity are rejected before creating a child.

`collect({ ids, timeoutSeconds: 0 })` reads current status. A bounded wait returns when a result is available or the timeout expires. `collect({ ids, awaitResults: true })` joins all requested results without polling; do not combine it with `timeoutSeconds`. Pending IDs are not failures. Completion states are `done`, `failed`, `killed`, or `timeout`, with native result, structured output, and error fields when available.

`model`, `thinking`, and `fastMode` select native child overrides, subject to the existing model and requester policies. `context` selects `fork` or `isolated`; native defaults apply when omitted. No ACP runtime is exposed by this facade.

```typescript
const native = api.runtime.subagent.native;
if (!native) throw new Error("Native children are unavailable in this runtime");

const child = await native.spawn({
  requestId: "review-implementation",
  task: "Review the implementation and report actionable findings.",
  context: "isolated",
  thinking: "high",
  fastMode: "auto",
});
const results = await native.collect({ ids: [child.runId], awaitResults: true });
// The claiming handler decides how to present results and completes its reply.
```

Supported ingress is the Gateway's normal reply-dispatch path with an existing admitted requester session, current operator authority, and the host's user-turn transcript recorder. Before spawning, the host adopts the turn when necessary and commits its actual input through that recorder. Existing restricted-ingress hook exclusions remain unchanged. Direct embedded/CLI `before_agent_reply` hooks, direct ACP dispatch, services, timers, and detached callbacks do not acquire this capability merely by holding its object. Custom runtimes may omit `native`; absence or an unsupported invocation fails explicitly.

Both calls recheck the invoking plugin's full-runtime lifetime and request authority after asynchronous preparation and at effect. The requester's effective native tool policy must allow both `sessions_spawn` and a callable native `agents_wait` for spawn, and `agents_wait` for collection; disabled Swarm/collector support, denied tools, revoked authority, or a retired hook cannot fall back to an administrator or system actor. Collection checks the exact parent session incarnation and native ownership; unrelated or reset parents cannot read a result.

A handler owns its calls only until it settles or times out. Accepted children transfer to native execution custody and do not automatically send a chat reply. A controller can await results while its handler remains active, or retain accepted IDs in its existing plugin store and collect during a later eligible invocation for the same parent incarnation. Persist controller decisions in the plugin's own store; this facade does not add a task engine, scheduler, or model-memory protocol. Existing `subagent.run`, `complete`, and `waitForRun` behavior is unchanged.

## Plugin-local subagent profiles

A profile adds package-owned instructions and can **only remove tools** from a
native child's inherited policy. It cannot select a model, identity, credentials,
authentication, or sandbox. Declare local profile IDs in the plugin manifest:

```json
{
  "contracts": {
    "subagentProfiles": ["reviewer"],
    "commandRuntimeCapabilities": ["subagents"]
  }
}
```

Probe both the optional registration method and the string capability before
registering. Undeclared plugins do not receive either surface; older hosts do not
advertise support. Existing spawns without a profile are unchanged.

```typescript
if (
  api.runtime.capabilities?.includes("native-subagent-profiles-v1") &&
  api.agent.registerSubagentProfile
) {
  api.agent.registerSubagentProfile({
    id: "reviewer",
    description: "Review a change without editing files",
    instructionsFile: "agents/reviewer.md",
    tools: { deny: ["group:fs", "group:runtime"] },
    outputSchema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false,
    },
  });
}

// Inside an eligible command or reply_dispatch invocation:
const child = await native.spawn({
  requestId: "review-change",
  task: "Review the requested change.",
  profile: "reviewer",
});
```

Use the deny list appropriate to the tools the reviewer needs; the example
removes file reads as well as writes. Tool policy names, aliases, and groups have
the same meaning as ordinary tool denies. An omitted or empty deny list grants
nothing: the requester ceiling and current host policy still apply. A read-only
reviewer should deny **every** write-capable tool it could inherit, including
plugin tools. A profile is not a sandbox for trusted in-process plugin code.

`id` is a local lowercase identifier (letter first, then letters, digits, `_` or
`-`, at most 64 characters). `description` and `instructionsFile` are required.
`instructionsFile` must be relative to the plugin package; missing files,
traversal, symlink escapes, hard links, invalid UTF-8, and files larger than
256 KiB are rejected. The host captures the whole file at registration. Edits on
disk do not change already registered instructions; reload the plugin to adopt
new bytes. Each child run records `subagentProfile` with `pluginId`, `id`,
`instructionsFile`, and the hex SHA-256 `instructionsSha256` of those exact bytes.
Existing queued-launch persistence retains the captured instructions.

`tools` accepts only `{ deny: string[] }`; `allow` and other widening fields are
rejected. Profiles are scoped to their registering plugin and invocation's
registry generation. Another plugin cannot select a profile by its local ID or
by prefixing the owner's ID. Every spawn retains the native requester's binding,
parent incarnation, and per-call authority rechecks; profile capture adds no
fallback authority.

`outputSchema`, when present, uses the existing native collector's structured
output enforcement. A caller cannot replace a profile schema with a spawn
`outputSchema`, and a tool hook cannot remove it. Without a profile schema, the
ordinary optional spawn `outputSchema` still works. Collection reports schema
failures normally; text alone is not a successful structured result.

Profiles are available only through the plugin's requester-bound native runtime,
including command-scoped native children. The model-facing `sessions_spawn`
schema does not expose `profile`: it has no registering-plugin identity. The
host carries the selected profile privately through that same native spawn path,
so model arguments or tool hooks cannot forge or replace its restrictions.

## Recover plugin-owned native children

Hosts advertising the string capability `native-subagent-list-v1` support optional
`native.list({ status? })` on both eligible reply-dispatch and command runtimes.
Probe the optional method before calling it; older hosts and custom runtimes may
omit it. An older record without host-captured ownership is not inferred to belong
to a plugin, even if its label, request key, or parent looks familiar.

Listing recovers native acceptance when the plugin did not persist its receipt.
It returns at most 200 entries, newest first (the returned run ID, in code-unit order, breaks equal-time ties):
`{ runId, childSessionKey, requestId, label?, status }`. The status filter is
applied before the bound, and an unknown status value is rejected. There is no pagination or completeness claim beyond
that bounded window. A known collector completion has status `done`, `failed`,
`killed`, or `timeout`; otherwise the native execution state is `queued`,
`running`, `interrupted`, or `terminal`. Terminal execution alone is not a
completed result; use `collect` for result/error data.

Only children accepted through this facade by the exact current plugin,
requester’s profile, and parent session incarnation are returned. Plugins cannot
supply those identities. A reset parent, another requester, or another plugin
cannot enumerate them. Listing rechecks request/plugin lifetime, native currency,
and the current `agents_wait` tool policy; revocation never falls back to an
administrator. This uses existing native custody and retention, not a separate
plugin index. If the runtime config changes during preparation or reading, listing
rejects with a policy-changed error; retry from the still-active invocation. Spawn,
collection, and reply dispatch signatures remain unchanged.

## Command-scoped native children

A registered slash command can request the same native spawn/collect runtime
without registering a `reply_dispatch` hook. Declare
`contracts.commandRuntimeCapabilities: ["subagents"]` in the manifest, then:

```typescript
api.registerCommand({
  name: "review-pr",
  description: "Launch a native review",
  requireAuth: true,
  runtimeCapabilities: ["subagents"],
  async handler(ctx) {
    const native = ctx.runtimeContext?.subagents;
    if (!native) return { text: "Native review is unavailable for this request." };
    const child = await native.spawn({
      requestId: "review",
      task: "Review the requested change and report actionable findings.",
    });
    const results = await native.collect({ ids: [child.runId], timeoutSeconds: 30 });
    // Persist pending IDs in the plugin store and offer a resume command.
    return {
      text: results.pending.length ? "Review started; resume to collect it." : "Review complete.",
    };
  },
});
```

The host advertises `command-native-subagents-v1` in the optional
`api.runtime.capabilities` array. Probe `ctx.runtimeContext?.subagents` at
invocation time: undeclared commands, unsupported hosts, denied native tool
surfaces, and non-requester command paths see `undefined`. Both
`sessions_spawn` and `agents_wait` must be allowed. Subsequent spawn denial
throws an explicit native error; it never launches an administrator fallback.

Only an authorized sender’s actual external command with current operator
authority is eligible. Quoted text, foreign commands, internal suggestions,
services, and timers cannot obtain the capability. Before exposing it, the host
adopts and commits the actual command text as a user turn and admits its current
requester under `auto-reply.plugin-command`. Children inherit that requester’s
lineage and effective tool ceiling. No new hook is registered, so Goal
start/resume and restart-safe chat admission keep their existing rules.

Gateway chat and channel text commands are both eligible. Messages without explicit
provenance use the ingress's ordinary sender authorization. On Gateway chat, an
authorized operator who is not an owner can spend child-model budget only under
that requester's tool ceiling. A channel message carries operator authority only
when its verified sender has a
[channel identity link](/concepts/user-model#channel-identity-links) to a
person whose current role grants `operator.admin`. That sender must also pass the
channel's command authorization. Unlinked, unverified, or demoted senders see
`undefined`, even when the channel lets them run the command, and every native
call rechecks the link and role. Demoting that person, removing their role, or
unlinking the identity revokes the requester's retained work as it does for a
Gateway operator: a child still waiting for a Swarm slot fails at once with a
visible error, and work that missed the change refuses at its next admission
check. The host records the channel command text once,
as that message's input: a reply adds only the response, and a continuing agent
turn reuses the same input. A native slash surface targeting a different
`CommandTargetSessionKey` than the current dispatch session gets no capability.
The deprecated direct command registrar cannot grant runtime capabilities; use
the managed `api.registerCommand` path with its reviewed manifest declaration.

The facade expires when the command settles; retained references fail closed.
`/stop` aborts in-flight command calls. Accepted children retain native custody;
store their IDs and collect in a later eligible invocation for the same parent
incarnation. After reset, old children return `not_owner`. Bounded waits and
resume/handoff behavior belong to the plugin, not a new host task engine.

Acceptance and completed collection results may include optional
`selection: { requested, resolved?, observed? }`. `requested` describes
explicit spawn controls (it can be empty on later collection). `resolved`
comes from the exact child’s host session controls, not the requested model or
a tool-result echo. `observed` is absent without independent host execution
evidence. Unknown facts remain absent; these receipts do not prove that a
provider honored a control.

## Requester-admitted scheduled commands

An eligible external command can request bounded, unattended command turns using
optional `ctx.runtimeContext?.scheduledTurns`. This is not a timer or a general
Gateway capability: registration, services, and retained invocation references
cannot create these schedules.

Declare both manifest contracts:

```json
{
  "contracts": {
    "commandRuntimeCapabilities": ["subagents", "scheduledTurns"],
    "sessionScheduledTurns": ["requester-command"]
  }
}
```

The scheduling command must set `requireAuth: true` and
`runtimeCapabilities: ["subagents", "scheduledTurns"]`. The target command must
belong to the same plugin, require authentication, support the current channel,
and declare `subagents`.

Feature-detect twice. Before registering the command, check that
`api.runtime.capabilities` includes `command-scheduled-turns-v1`; hosts without
it reject a command that requests `scheduledTurns`, so register a variant
without it instead. At invocation time, probe `ctx.runtimeContext?.scheduledTurns`.
An absent capability must not fall back to a system or administrator schedule.

```typescript
const schedules = ctx.runtimeContext?.scheduledTurns;
if (!schedules) return { text: "Scheduled continuation is unavailable." };
const accepted = await schedules.schedule({
  requestId: "review-resume",
  command: "review-pr", // registered command name, without a slash
  args: "resume",
  schedule: { kind: "every", everyMs: 60_000 },
  deadlineAtMs: Date.now() + 30 * 60_000,
  maxRuns: 10,
});
return {
  text:
    "Continuation scheduled: " +
    accepted.jobId +
    (accepted.survivesRestart ? "" : " (ends if the Gateway restarts)"),
};
```

Use an `at` schedule with an ISO `at` value for a single occurrence, or
`every` with `everyMs >= 1000`. Every occurrence must precede the deadline,
which can be at most seven days from invocation preparation. `maxRuns` is an
integer from 1 to 100. An activated native launch spends an attempt even if
subsequent authorization fails or execution is interrupted; queued preparation
and capacity deferral do not. Restart recovery never refunds attempts.

The schedule is retired (disabled, with no next run) in the same scheduler
transaction that launches its final allowed attempt, or that finds its deadline
passed, its attempts exhausted, or, after a Gateway restart, no matching loaded
plugin. A retired schedule never wakes again, including after later restarts,
and stays visible for inspection. One invocation can create at most 4
schedules, and each plugin can keep at most 8 active schedules per parent
session. Enabled schedules bound to the loaded plugin instance count toward that
cap, as do unexpired schedules of the same plugin code that a restart can
re-arm. Schedules bound to a replaced plugin instance or to different code can
never run plugin code again, so they do not block re-enrollment; each one
retires at its next occurrence.

The stored ceiling is the requester's whole native tool surface, at most 256
plain tool names. A larger surface refuses scheduling with an explicit error.

Identical calls with one `requestId` within the invocation join the same native
job. Changed input refuses rather than replacing or rearming it. A refused call
can be retried with the same `requestId`; if an earlier attempt was committed,
the retry returns that job rather than creating another. The native cron store
owns persistence, receipts, and recovery. Normal authorized cron management can
disable or remove a schedule; editing or rearming it is not supported. Disabling
also refuses manual force runs, so a disabled schedule cannot spend attempts.

Each run restores the original requester and revalidates current operator,
provider-account, session, plugin, and native tool authority. It reuses the
command-scoped native-child eligibility producer. Reset, deletion, revocation,
expired budgets, and unloaded plugins fail closed. Revoking a channel requester
also fails a child that an earlier occurrence queued, without waiting for its
Swarm slot. Stored source facts are not execution authority. No caller can
choose a different parent or delivery route.

Within one Gateway process, schedules bind the exact managed plugin instance,
not just its ID, version, or source path. Registry adoption of that same
instance preserves the binding. After an in-process plugin reload, the first
occurrence that finds another live instance of the plugin is refused without
running plugin code and retires the schedule; it does not wait for generic
repeated-failure auto-disable. That refusal spends one attempt. A transient gap,
such as a registry swap that keeps the same instance or a plugin that is still
unloading, is an ordinary refusal that retries at the next occurrence.

Accepted schedules survive a Gateway restart on hosts advertising
`command-scheduled-turns-restart-v1` in `api.runtime.capabilities`. The accepted
result's `survivesRestart` reports this for each schedule; when it is true, do
not re-enroll that schedule after a restart. When it is false, or absent on
hosts without the capability, the schedule ends with the Gateway process and a
plugin must re-enroll from a later eligible requester command. That happens only
when the loaded plugin code has no sound identity, described below. After a
restart, each schedule keeps its original deadline, `maxRuns` and spent attempts, and a missed
occurrence follows the scheduler's normal startup deferral. Its next
occurrence re-arms it onto the newly loaded instance of the same plugin code, in
the same scheduler transaction that claims the occurrence. Matching metadata is
not enough: the instance must have the same plugin ID, source, root and version,
must still register the target command, and must have loaded exactly the code
identity captured when the schedule was accepted. That
occurrence then restores the original requester and rechecks it, the parent
session and the plugin exactly as any other occurrence does. A demoted or
removed requester is refused before the command runs. If the plugin is disabled,
uninstalled, or its code changed, the occurrence retires the schedule without
running plugin code or spending an attempt; re-enabling or restoring the plugin
later does not revive it. An expired or exhausted schedule is never re-armed. Disabled,
removed and completed schedules stay ended. An occurrence interrupted by the
restart is not replayed once its command may have started, so a restart never
runs one occurrence twice. Neither persisted jobs nor restart continuity restore
execution authority on their own.

The code identity of an installed or configured plugin is the digest of its
captured source. A core-bundled plugin loads host-owned modules instead, so its
identity is the exact OpenClaw build the Gateway process loaded: the record in
that build's `dist/build-info.json` (build ID, version, commit and build time),
read once when the process starts, together with the plugin's ID and the real
paths of its root and entry inside that build's own `dist` or `dist-runtime`
extensions. Every build records a new build time, even under an explicit build
ID, so after a host upgrade, downgrade or rebuild a bundled plugin's schedule
ends exactly as a changed installed plugin's does, even at the same paths and
plugin version, and returning to the original build later does not revive it. A Gateway run from
source has no build record, and a bundled plugin loaded from outside its build's
output (a source checkout or an override directory) has no identity, so those
schedules report `survivesRestart: false` and end with the process.

Schedules are stored under a dedicated `pluginCommand` payload kind. An older
Gateway that does not support scheduled command turns treats that row as an
invalid job and never runs it as an ordinary model prompt. Restart continuity is
stored privately in the job's runtime state and leaves the stored schedule
unchanged. After a rollback, a Gateway that supports scheduled turns but not
restart continuity ignores it and ends each schedule at its next occurrence, as
it ends its own schedules after a restart. A Gateway with restart continuity
that predates bundled-plugin build identities finds no matching code for a
bundled plugin's schedule and ends it the same way. That ended schedule stays
ended after upgrading again.

Scheduled invocations expose native spawn/collect, not another scheduling
capability. Direct command `llm.complete` and `continueAgent` are refused:
model work must use admitted native children. Text/media output is recorded only
in the exact original parent transcript, without channel announcement. Retained
runtime callbacks and late results cannot create effects after their invocation
closes. This does not sandbox trusted in-process plugin code.

## Background work namespaces

<AccordionGroup>
  <Accordion title="api.runtime.hooks">
    Dispatch isolated agent turns for untrusted external-content triggers, such
    as an email watcher. Unlike `api.runtime.subagent.run(...)`, hook dispatch
    wraps external content, serializes runs for the same session, and reports
    completion through the Gateway. Plugin turns share the cron execution
    budget without requiring the HTTP hooks endpoint. When HTTP hooks are
    enabled, one slot in that shared budget remains reserved for HTTP work.

    ```typescript
    const result = await api.runtime.hooks.dispatchHookAgentTurn({
      name: "IMAP inbox",
      agentId: "mail",
      sessionKey: "hook:imap:account:123:456",
      message: "Summarize the new email and identify any requested actions.",
      externalContentSource: "email",
      deliver: true,
      thinking: "low", // optional
      timeoutSeconds: 60, // optional
      idempotencyKey: "account:123:456", // optional
    });

    if (!result.ok) {
      api.logger.warn(`Hook agent turn was rejected: ${result.reason}`);
    }
    ```

    `agentId` is required, and `sessionKey` must begin with `hook:` and contain
    no whitespace or control characters. `externalContentSource` currently
    accepts only `"email"`; external-content wrapping cannot be disabled. Set
    `deliver` to `false` to record completion without announcing it. Successful
    admission returns `{ ok: true, runId }`; rejected admission returns
    `{ ok: false, reason }`.

    This capability is available only to bundled plugins and trusted official
    plugin installations. It does not require enabling or configuring the HTTP
    hooks endpoint.

  </Accordion>
  <Accordion title="api.runtime.subagent">
    Launch and manage background subagent runs.

    For a tool-free completion that needs no retained session or reply delivery,
    use `complete(...)`:

    ```typescript
    const { text } = await api.runtime.subagent.complete({
      agentId: "research", // required configured agent that owns this work
      message: "Summarize these notes.",
      extraSystemPrompt: "Return a concise summary.", // optional
      timeoutMs: 30_000, // optional; defaults to 30 seconds
      // model: "openai/gpt-5.6-luna", // optional authorized override
      // signal: abortController.signal, // optional cancellation
    });
    ```

    `agentId` and `message` are required. `extraSystemPrompt`, `model`,
    `timeoutMs`, and `signal` are optional. The selected agent supplies its
    configured default model and credential owner when `model` is omitted.
    The result is `{ text: string }`; no session creation, message polling,
    deletion, or completion delivery is needed. The configured runtime must
    support fresh, tool-free isolated inference; unsupported runtimes fail
    before inference.

    Completions use the [subagent queue](/concepts/queue#background-work) at
    background priority, sharing `agents.defaults.subagents.maxConcurrent`
    across plugins and workspaces. Set this existing limit to `1` to serialize them.
    Cancellation removes queued work immediately. Running work keeps its slot
    until underlying runtime cleanup finishes, then rejects; late output is not
    returned after cancellation, timeout, or runtime retirement. Calls require
    a live Gateway binding and plugin identity. Request-scoped calls retain the
    caller's operator scopes and agent access; completions started inside an
    operator tool invocation are cancelled when that invocation ends.
    Model overrides retain the
    existing subagent authorization and `allowedModels` policy below.

    Use `run(...)` when you need a session or an agent tool surface:

    ```typescript
    // Start a subagent run
    const { runId, sessionKey } = await api.runtime.subagent.run({
      sessionKey: "agent:main:subagent:search-helper",
      message: "Expand this query into focused follow-up searches.",
      toolsAlsoAllow: ["my_plugin_progress"],
      promptMode: "minimal", // optional bounded subagent prompt
      provider: "openai", // optional override
      model: "gpt-6-astra", // optional override
      deliver: false,
      completionDelivery: "current-requester", // optional, before_dispatch hooks only
    });

    // Wait for completion
    const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });

    // Read session messages
    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey: "agent:main:subagent:search-helper",
      limit: 10,
    });

    // Delete a session
    await api.runtime.subagent.deleteSession({
      sessionKey: "agent:main:subagent:search-helper",
    });
    ```

    Gateway-backed runs return the normalized accepted `sessionKey` alongside `runId`. The field is optional in the TypeScript result only so explicit custom runtimes remain compatible.

    `waitForRun(...)` returns the standard Gateway wait result. `status` is `"ok"`, `"error"`, `"timeout"`, or `"pending"`; pending is a normal nonterminal observation, not an exception. Optional `error`, `startedAt`, `endedAt`, `stopReason`, `livenessState`, `yielded`, `pendingError`, `timeoutPhase`, `providerStarted`, and `terminalReply` metadata is preserved so callers can distinguish observation timeouts from terminal outcomes. `timeoutMs` bounds the wait call; it does not cancel the run.

    <Warning>
    Outside an authorized Gateway request, model overrides require operator opt-in via `plugins.entries.<id>.subagent.allowModelOverride: true` in config. Plugins without that opt-in can use the configured model, but override requests are rejected.
    </Warning>

    `plugins.entries.<id>.subagent.allowedModels` can restrict overrides to
    normalized `provider/model` targets. The same policy applies to `complete`;
    request-scoped calls retain their authenticated client's override authority.
    The check uses the destination agent's model configuration, including exact
    configured model IDs, and applies to the plugin's initial override. Configured
    defaults, operator-installed model routing hooks, and automatic model fallbacks
    retain their own selection policies.

    `toolsAlsoAllow` adds exact, uniquely owned tools registered by the calling plugin to the worker's normal tool surface. The runtime rejects core tools and names shared with another plugin. Profiles and operator tool policies still apply, including explicit allowlists and denies.

    Owner-authorized command launches can pass their captured assertion as
    `subagent.run({ ..., assertCurrent })`; the Gateway applies it at run
    admission. Managed `worktrees.create({ ..., commitGuard })` accepts the same
    assertion through its existing creation owner. Revocation prevents pending
    launches or worktree writes, while accepted work retains its cleanup and
    completion responsibilities.

    `promptMode: "minimal"` selects the bounded subagent prompt instead of the full conversation prompt. The plugin runtime exposes only this mode; omission keeps the full prompt. Use `disableTools: true` as well when the run must have an exact empty tool surface.

    `completionDelivery: "current-requester"` is default-off and is only available while a `before_dispatch` hook is handling an authenticated inbound request. OpenClaw captures the resolved requester session and delivery route before invoking the plugin, then delivers the subagent completion through the normal announce path. Plugins cannot provide or override requester lineage or destination fields. Calls outside that requester-bound hook context are rejected.

    `deleteSession(...)` can delete sessions created by the same plugin through `api.runtime.subagent.run(...)`. Deleting arbitrary user or operator sessions still requires an admin-scoped Gateway request.

  </Accordion>
</AccordionGroup>

## Native harness continuation retry settings

`AgentHarnessHostCapabilities.prepareContinuationRetryCount?.({ cwd })` prepares
the host's continuation retry count from the native owner's admitted **Gateway-local**
execution directory. Call it after permission and workspace resolution, before tools
or inference, inside the attempt's cleanup owner. Do not pass a remote or container
path, infer a Gateway mirror, or call it from isolated finalization.

The host freezes `retry.provider.maxRetries`, including absence, and applies an
explicit count over the harness result's `providerRetryMaxRetries`. Repeated calls
with the same cwd reuse that prepared value; changing cwd throws. Retained callbacks
reject after their host or admission closes. Native request retries, delay policy,
and timeouts remain harness-owned.

The capability is additive and optional. Harnesses that do not participate retain
their result budget/default. Local Codex, Copilot, and Muse participate; ACP and
remote/provider-hosted settings projection require a separate owner contract.

## Native harness completion delivery

Bundled harnesses use `openclaw/plugin-sdk/agent-harness-completion` to route
native child results through the existing requester completion-delivery owner.
`deliverAgentHarnessCompletion` requires a host-issued `AgentHarnessCompletionScope`
and a live `isSourceSessionAdmissionAllowed` callback. Keep the callback bound
to the exact native assignment and its current parent. Requester identity and
admission are rechecked after awaited routing and before new effects.
Native runtime history, cancellation, and submission receipts remain owned by
the harness; there is no generic task registry or managed-flow API.

For detached native work, await `captureAgentHarnessCompletionCustody(scope)`
during the admitting parent registration, before publishing the registration or
starting native child work. Preparation retains the original requester lifecycle
and rejects replacement or revocation before returning custody. Each accepted child assignment retains
its own hold with `retain()` and passes it as `completionCustody` when delivering
its result. Release each hold when its registration or assignment ends. The hold
preserves the original operator ceiling and requester lifecycle; it does not
grant general tool access or survive revocation or Gateway closure.

Bind `createAgentHarnessCompletionEventSink(...)` to the same completion custody
and an `isSourceCurrent` callback for the exact native assignment. After native
terminal persistence and the first completion handoff settle, call
`completionCustody.settleExecution()` before sleeping delivery retries. This
releases the execution drain obligation while retaining completion delivery
authority. After a restart, recovery must capture fresh custody from a live
registration and validate its requester; stored history never grants authority.
