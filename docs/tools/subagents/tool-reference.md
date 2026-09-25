---
summary: "Context modes and the sessions_spawn, sessions_yield, and subagents tool contracts"
title: "Sub-agent tool reference"
read_when:
  - You are calling sessions_spawn and need its parameters
  - You need to choose between isolated and forked child context
  - You are waiting for child results with sessions_yield
---

## Context modes

Native sub-agents start isolated unless the caller explicitly asks to fork the
current transcript. Pass `context: "isolated"` explicitly when the child must
start with clean context.

| Mode       | When to use it                                                                                                                         | Behavior                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `isolated` | Fresh research, independent implementation, slow tool work, or anything that can be briefed in the task text                           | Creates a clean child transcript. Default for all spawns; keeps token use lower.  |
| `fork`     | Work that depends on the current conversation, prior tool results, or nuanced instructions already present in the requester transcript | Branches the requester transcript into the child session before the child starts. |

Use `fork` sparingly. It is for context-sensitive delegation, not a
replacement for writing a clear task prompt.

## Tool: `sessions_spawn`

Starts a sub-agent run on the spawning session's sub-agent queue, with
[per-session concurrency](/tools/subagents/operations#concurrency). Ordinary one-shot runs
use `deliver: false` and return through an announce step; collectors, quiet
runs, and user-started thread sessions use the
[completion paths](/tools/subagents/slash-command#spawn-behavior).

Availability depends on the caller's effective tool policy. The built-in
`coding` and `messaging` profiles include `sessions_spawn`,
`sessions_yield`, and `subagents`; `minimal` does not. `full` allows every
tool. Add those tools with `tools.alsoAllow`, or use one of the profiles
above, for an agent on a custom narrower profile that should still
delegate work.
Channel/group, provider, sandbox, and per-agent allow/deny policies can
still remove the tool after the profile stage. Use `/tools` from the same
session to confirm the effective tool list.

**Defaults:**

- **Model:** same-agent native sub-agents inherit the caller's active model, including session and one-shot overrides, unless you set `agents.defaults.subagents.model` (or per-agent `agents.entries.*.subagents.model`). The inherited model ID is preserved exactly, even when it contains a provider prefix. Cross-agent spawns use the target agent's configured model. ACP runtime spawns use the same configured subagent model when present; otherwise the ACP harness keeps its own default. An explicit `sessions_spawn.model` still wins.
- **Thinking:** native sub-agents inherit the caller's active turn, including one-shot thinking overrides, unless you set `agents.defaults.subagents.thinking` (or per-agent `agents.entries.*.subagents.thinking`). ACP runtime spawns also apply the target agent's `thinkingDefault`, then its per-model `agents.entries.*.models["provider/model"].params.thinking` or the shared `agents.defaults.models["provider/model"].params.thinking`. An explicit `sessions_spawn.thinking` still wins.
- **Fast mode:** with swarm enabled, native sub-agents inherit the requester's setting only when the resolved child provider and model match the requester's active model. A different child model uses its own defaults. Explicit `sessions_spawn.fastMode` values (`true`, `false`, or `"auto"`) take precedence; aliases resolving to the same model preserve inheritance.
- **Run timeout:** pass `runTimeoutSeconds` to set a timeout for a specific native, ACP, or visible sub-agent run. When omitted, OpenClaw uses `agents.defaults.subagents.runTimeoutSeconds` if configured; otherwise it falls back to `0` (no timeout). An explicit `0` disables the timeout for that run.
- **Process lifetime:** a detached OpenClaw sub-agent has its own run lifecycle. A background task created inside an external CLI backend is different: it shares the parent CLI subprocess and stops if that parent reaches `agents.defaults.timeoutSeconds`.
- **Task delivery:** hidden and visible native sub-agents receive their delegated task in a `[Subagent Task]` message appended after any forked history. The message identifies the current child assignment and treats inherited conversation as background context. The hidden sub-agent system prompt carries runtime rules and routing context, not a duplicate of the task.

Native sub-agent continuations after a Gateway restart or descendant completion
preserve the recorded run timeout, including `0` for no timeout.

Accepted native sub-agent spawns report their actual initialized `context`
(`fork` or `isolated`), including `isolated` when a requested fork exceeds the
parent-context size cap. The size check includes context added since the latest
model response, such as completed tool output, and respects compaction and reset
boundaries. An oversized fork starts isolated with an explanatory note. Spawns
also include resolved child model metadata:
`resolvedModel` contains the applied model ref and `resolvedProvider` contains
the provider prefix when the ref has one.

### Cloud placement

`placement` is optional. Omit it to default to local execution, or select local
execution explicitly with `{ "kind": "local" }`. Both forms support native
subagents (including hidden review and test workers), visible sessions, and ACP
runs under their existing runtime and visibility rules. Local placement does not
accept cloud selectors. Do not supply dummy profile, OS, or machine identifiers.
An existing local worktree needs only `cwd`, not `worktree: true`:

```json
{
  "task": "Review the current changes and report findings",
  "runtime": "subagent",
  "mode": "run",
  "cwd": "/path/to/existing/worktree",
  "placement": { "kind": "local" },
  "completionTarget": "parent"
}
```

Omitting `placement` in this example has the same local behavior. For intentional
cloud execution, use `visible: true`, `worktree: true`, and a real configured
profile. Invalid placement, mixed local/cloud selectors, and failed cloud
placement do not fall back to local execution.

Discover configured profiles with `sessions({ action: "cloud_profiles" })`. The list returns at most 32 summaries and supplies `nextOffset` when another page is available. Pass that value as `offset`. Request `sessions({ action: "cloud_profiles", profileId: "build" })` for that profile's operating systems, availability, defaults, and per-OS machine classes. Discovery reads the same provider-authored catalog as the Control UI, not profile settings or credentials.

Then start the child using the selected identifiers:

```json
{
  "task": "Run the project tests on Linux and report failures",
  "visible": true,
  "worktree": true,
  "placement": {
    "kind": "profile",
    "profileId": "build",
    "os": "linux",
    "machineClass": "tiny"
  }
}
```

Cloud placement requires a live hosted Gateway session; standalone and local-embedded transports are rejected before creation. Cloud spawning waits for placement before returning acceptance; acceptance does not mean the task has finished. The result includes the resolved placement and the normal child session/run identifiers. The existing spawn policy, child limits, inherited tool restrictions, and Gateway placement authorization still apply.

An error with `childSessionKey` means the child was retained. `initialTaskStatus: "not-sent"` means the tool did not submit its initial task; `"unknown"` means task admission was attempted but not confirmed. Inspect that child and its placement before retrying. Do not repeat the spawn merely because provisioning or the initial reply timed out. An attempted task that cannot be registered is settled through exact-run cancellation; its session and worker are preserved for inspection.

Selecting a cloud profile is available only to Gateway-side visible spawns. The restricted cloud-worker spawn tool keeps its existing parent-profile inheritance contract; it does not accept a different profile, OS, or size.

### Delegation prompt mode

`agents.defaults.subagents.delegationMode` controls prompt guidance only; it does not change tool policy or enforce delegation. With no explicit setting, OpenClaw uses `prefer` in each agent's main session and `suggest` in every other session.

- `suggest`: keep the standard prompt nudge to use sub-agents for larger or slower work.
- `prefer`: tell the agent to stay responsive and delegate anything more involved than a direct reply through `sessions_spawn`.

An explicit default or per-agent setting always wins, including `suggest` in a main session and `prefer` elsewhere. Per-agent overrides use `agents.entries.*.subagents.delegationMode`.

In either mode, internal QA, research, coding, review, and test lanes use ordinary subagents and return their results to the parent task. Use `sessions_spawn` with `visible: true` only when the user requests a separate session or needs to revisit and steer the work independently. A PR or report, long runtime, or isolated worktree alone does not justify a persistent sidebar session. Asking for subagents does not ask for separate sessions.

```json5
{
  agents: {
    defaults: {
      subagents: {
        delegationMode: "prefer",
        maxConcurrent: 4,
      },
    },
    entries: {
      coordinator: {
        default: true,
        subagents: { delegationMode: "prefer" },
      },
    },
  },
}
```

### Tool parameters

<ParamField path="task" type="string" required>
  The task description for the sub-agent.
</ParamField>
<ParamField path="taskName" type="string">
  Optional stable handle for identifying a specific child in later status output. Must match `[a-z][a-z0-9_-]{0,63}` and cannot be a reserved target such as `last` or `all`.
</ParamField>
<ParamField path="label" type="string">
  Optional short task title shown in transcript activity and Tasks views, and in the session sidebar for visible sessions. Name the work being done, not the agent; it is set on the child session at run start.
</ParamField>
<ParamField path="agentId" type="string">
  Spawn under another configured agent id when allowed by `subagents.allowAgents`.
</ParamField>
<ParamField path="cwd" type="string">
  Optional task working directory for the child run. Native sub-agents still load bootstrap files from the target agent workspace; `cwd` only changes where runtime tools and CLI harnesses do the delegated work. For visible sessions, paths outside configured agent workspaces require `operator.admin`. With `worktree: true`, omitting `cwd`, `projectId`, and `projectGitUrl` inherits the same-agent parent's live managed repository or directly selected registered project; otherwise the target agent workspace is used.
</ParamField>
<ParamField path="projectId" type="string">
  Select a registered project through the same managed-project flow as New session. Requires `visible: true`; mutually exclusive with `projectGitUrl` and `cwd`. Registry selection does not grant arbitrary host-path access or bypass sandbox containment.
</ParamField>
<ParamField path="projectGitUrl" type="string">
  Select a GitHub HTTPS or `git@github.com` repository URL for a managed clone through New session's existing preparation flow. Requires `visible: true`; mutually exclusive with `projectId` and `cwd`. Local paths, file URLs, and non-GitHub hosts are rejected. Existing Gateway GitHub credentials and sandbox checks apply.
</ParamField>
<ParamField path="runtime" type='"subagent" | "acp"' default="subagent">
  `acp` is only for external ACP harnesses (`claude`, `droid`, `gemini`, `opencode`, or explicitly requested Codex ACP/acpx) and for `agents.entries.*` entries whose `runtime.type` is `acp`.
</ParamField>
<ParamField path="resumeSessionId" type="string">
  ACP-only. Resumes an existing ACP harness session when `runtime: "acp"`; ignored for native sub-agent spawns.
</ParamField>
<ParamField path="streamTo" type='"parent"'>
  ACP-only. Streams ACP run output to the parent session when `runtime: "acp"`; omit for native sub-agent spawns.
</ParamField>
<ParamField path="model" type="string">
  Override the sub-agent model. Invalid values are skipped and the sub-agent runs on the default model with a warning in the tool result.
</ParamField>
<ParamField path="runTimeoutSeconds" type="integer">
  Override the configured run timeout for this child. Must be a non-negative integer; `0` disables the timeout. Applies to native, ACP, and visible sessions.
</ParamField>
<ParamField path="thinking" type="string">
  Override thinking level for the sub-agent run. Not available with `visible: true`.
</ParamField>
<ParamField path="thread" type="boolean" default="false">
  Not offered. Agent-started spawns never bind a chat thread or conversation, for native sub-agents and ACP alike. An older call with `thread: true` still succeeds: the child runs as a one-shot background run, its result returns to the requester, and the result `note` says that thread binding is not available for agent-started spawns. To start a sub-agent in a new thread, the user runs `/subagents spawn --thread <task>`.
</ParamField>
<ParamField path="mode" type='"run"' default="run">
  Only `"run"` (one-shot). An older call with `mode: "session"` (also with `runtime: "acp"`) runs as a one-shot background run and says so in the result `note`. Agent-started ACP spawns are always one-shot.
  With `visible: true`, omit `mode` or use the default `"run"`; the visible session remains persistent.
</ParamField>
<ParamField path="cleanup" type='"delete" | "keep"' default="keep">
  `"delete"` archives the session immediately after announce. The Control UI's **Tasks** inspector can preview the retained transcript under the [post-cleanup access rules](/tools/subagents/announce#announce).
</ParamField>
<ParamField path="expectsCompletionMessage" type="boolean" default="true">
  Set `false` for fire-and-forget children. When the child finishes, OpenClaw skips the completion handoff to the requester (no announce or steer turn), records the delivery as not required, and still runs child cleanup. Inspect such children with `subagents` or `sessions_history`. `collect: true` always uses `false`.
</ParamField>
<ParamField path="completionTarget" type='"parent"'>
  Return the result in a private requester turn with no automatic channel delivery. The parent may continue work or remain silent. Supported only for hidden native children; unavailable with ACP, `collect`, `visible`, or `expectsCompletionMessage: false`. Omit to keep normal completion delivery. See [Private parent completion](/tools/subagents/announce#private-parent-completion).
</ParamField>
<ParamField path="sandbox" type='"inherit" | "require"' default="inherit">
  `require` rejects the spawn unless the target child runtime is sandboxed.
</ParamField>
<ParamField path="context" type='"isolated" | "fork"'>
  `fork` branches the requester's current transcript into the child session, including the in-progress user turn and completed tool results. The requester can keep running while its visible or hidden child starts. Native sub-agents only. Omitted context is `isolated`. All native forks, hidden or visible, must target the same agent as the requester.
  Codex-backed forked children receive completed tool output with secrets redacted and historical tool inputs summarized. Context size limits still apply.
</ParamField>
<ParamField path="visible" type="boolean" default="false">
  Create a persistent dashboard session only when the user requests a separate session or needs to return to and steer the work independently. Omit this flag or use `false` for internal QA, research, coding, review, and test workers supporting the parent task. Visible spawns support only `runtime: "subagent"` and always keep the created session.
</ParamField>
<ParamField path="placement" type="object">
  Omit to default to local execution, or use `{ kind: "local" }` explicitly without cloud selectors. For a visible worktree session on a configured cloud profile, use `{ kind: "profile", profileId, os?, machineClass? }` with `visible: true` and `worktree: true`; OS and machine IDs come from cloud profile discovery. Omitted cloud selectors use the profile defaults. The Gateway creates the cloud child without starting its task, dispatches it, then admits its first task on the worker. Invalid placement and failed or uncertain cloud starts never silently fall back to local execution; a failed cloud start retains the child for inspection.
</ParamField>
<ParamField path="group" type="string">
  Optional custom sidebar group for a visible session; a new name creates the group. Omitted, empty, and whitespace-only values mean ungrouped and are also accepted for hidden or ACP runs. A nonempty group requires `visible: true`.
</ParamField>
<ParamField path="worktree" type="boolean" default="false">
  Provision a managed git worktree for the new dashboard session. Requires `visible: true`.
</ParamField>
<ParamField path="worktreeName" type="string">
  Optional managed-worktree name. Requires `visible: true` and `worktree: true`.
</ParamField>
<ParamField path="worktreeBaseRef" type="string">
  Optional git base ref for the managed worktree. Requires `visible: true` and `worktree: true`.
</ParamField>

<Warning>
`sessions_spawn` does **not** accept channel-delivery params (`target`,
`channel`, `to`, `threadId`, `replyTo`, `transport`). Native sub-agents report
their latest assistant turn back to the requester; external delivery stays with
the parent/requester agent.
</Warning>

With `visible: true`, `group`, `model`, `cwd`, `projectId`, `projectGitUrl`, and a same-agent `context: "fork"` are supported. Reserve this durable mode for a separate session the user requests or needs to revisit and steer independently; it appears in the sidebar when the web UI is available and still works without it. Internal QA, coding, review, and test lanes stay ordinary subagents even when they produce a PR or report or need isolated source work. A managed worktree is a capability of visible sessions, not a reason to create one for an internal worker. Pass `group` to place the new session in that sidebar group atomically; omitted or blank values leave it ungrouped. A sandboxed target restricts `cwd` to that agent's workspace. Non-admin callers may use `cwd` only inside a configured agent workspace. With `worktree: true`, omitting `cwd`, `projectId`, and `projectGitUrl` inherits the same-agent parent's live managed repository or directly selected registered project and creates a separate worktree. Other spawns use the target agent workspace. For another repository, omit `cwd` and select exactly one of `projectId` or `projectGitUrl`; both reuse the existing New session preparation flow at ordinary write scope. Add `worktree: true` for a separate managed worktree. Project selection does not bypass the target sandbox or grant permission to run worktree setup scripts. Do not replace a rejected persistent spawn with the synchronous `openclaw agent` CLI, whose command deadline defaults to 600 seconds. Thread binding, `mode: "session"`, thinking overrides, `lightContext`, and attachment staging are unavailable on this path because visible sessions are persistent dashboard sessions created through `sessions.create`. The default `mode: "run"`, empty `attachments`, and an empty `attachAs.mountPath` are accepted without changing that behavior. The new dashboard child inherits the requester's effective tool-policy ceiling before its first turn. Session listing and addressing obey `tools.sessions.visibility`; the default `all` scope covers sessions across agents on the Gateway for unsandboxed callers. Cross-agent access is on by default and governed by `tools.agentToAgent`; use `allow` to restrict agent pairs or set `enabled: false` to block ordinary cross-agent access (requester-owned native subagent and ACP child sessions stay reachable under `tree` or `all`). Set `agent` for same-agent-only access, `tree` for current plus spawned scope (main retains its same-agent exception), or `self` for current-session-only access. Sandbox spawned-only clamps still apply. Cross-agent owned children are included by `tree`, not `agent`; preserve explicit `tree` for that workflow. See [Session tools](/concepts/session-tool#visibility) and [Managed worktrees](/concepts/managed-worktrees).

If a call fails with `Parameters require visible=true`, omit the named project, group, or worktree options to keep the hidden or ACP runtime. To create a visible session instead, use `visible: true` with `runtime: "subagent"` and omit `mode`, `thread`, `thinking`, `lightContext`, `attachments`, `attachAs`, swarm options, and the ACP-only `streamTo` and `resumeSessionId`. Worktree names and base refs also require `worktree: true`. Adding `visible: true` alone does not make an ACP call compatible.

A visible spawn is attributed to the requesting agent: the new session's creator and initial owner is that agent, shown with its configured identity name and avatar in the sidebar. The accepted result doubles as a receipt with `childSessionKey`, `runId`, a Control UI `sessionUrl` (omitted when the Control UI is disabled), and an `owner` record. When acknowledging the spawn in a channel, put the session URL on the first line and `Owner: <label>` on the second so the user can open the session and see who is responsible. Owners can be reassigned later; see [Multi-user mode](/concepts/multi-user#agent-spawned-sessions).

### Task names and targeting

`taskName` is a model-facing handle for orchestration, not a session key.
Use it for stable child names such as `review_subagents`,
`linux_validation`, or `docs_update` when a coordinator may need to inspect
that child later.

Target resolution accepts exact `taskName` matches and unambiguous
prefixes. Matching is scoped to the same active/recent target window used
by numbered `/subagents` targets, so a stale completed child does not make
a reused handle ambiguous. If two active or recent children share the same
`taskName`, the target is ambiguous; use the list index, session key, or
run id instead.

The reserved targets `last` and `all` are not valid `taskName` values
because they already have control meanings.

## Tool: `sessions_yield`

Ends the current model turn and waits for announced child completion events
to arrive as the next message. Use it when the requester needs results from
announcing children before answering. It does not collect Swarm results:
collectors require `agents_wait`, or an awaited `agents.run()` in OpenClaw
Code Mode, and do not send completion notifications.

`sessions_yield` is the waiting primitive for announced completions. Do not replace it with polling
loops over `subagents`, `sessions_list`, `sessions_history`, shell
`sleep`, or process polling just to detect child completion.

When an earlier async tool call in the same model response has results the model
has not received yet, OpenClaw defers `sessions_yield` and keeps the turn active.
Finish the model response so the next request can deliver those results, then
yield only if external work still requires waiting. This applies even when the
tool has already finished and its result appears in the transcript.

Use the optional `message` field for private context that the resumed turn
should receive. OpenClaw sends a default waiting reply when an interactive
parent turn would otherwise end silently; `acknowledgment` overrides its text. It is not sent from
sub-agent, heartbeat, or silent turns, and it does not replace a reply or
message already delivered during the turn. This host-owned waiting status
bypasses message-tool-only source suppression; ordinary model replies remain
private unless the model sends them through the message tool.

On native Codex harness turns, `wait_agent` keeps the current turn active and
is reserved for an intentional same-turn wait when the immediate next step is
blocked on the child. Use `sessions_yield` instead when a native child's result
should resume the parent in a later turn.

Only use `sessions_yield` when the session's effective tool list includes
it. Some minimal or custom tool profiles may expose `sessions_spawn` and
`subagents` without exposing `sessions_yield`; in that case, do not invent
a polling loop just to wait for completion.

A sub-agent can also explicitly set `waitFor: "message"` to wait for an incoming
continuation about external work, such as a remote job it does not drive itself.
This does not schedule that message; an operator or integration must send it.
Without a real pending child/runtime completion or this explicit message intent,
yield is rejected. Return completed work as the normal final response:
`sessions_yield` is not a final-result submission. An accepted yield pauses
the child run instead of completing it, so the requester receives no
completion event yet and keeps waiting. A plugin can then continue that same run
by calling `api.runtime.subagent.run` with the paused `sessionKey`, instead of
starting a sibling. The requester is announced once such a follow-up finishes
normally; a follow-up that yields again leaves the run paused and the requester
waiting.

A yield claim belongs to the turn that spawned the children. When a later turn
of the same session calls `sessions_yield` while children spawned by an earlier
turn are still running or still owe their completion, the tool returns
`status: "already_pending"` with the pending children (session key, label,
start time, `running`/`completing`/`paused` state, and whether an earlier
yield already armed the wake) instead of an error. For running or completing
children nothing else is required: end that turn normally, and the child's
completion arrives in the session as a later turn. Do not re-spawn, re-send,
or poll to wake them. A `paused` child yielded with `waitFor: "message"` and
will not complete until it receives a continuation; send one with
`sessions_send` if this session owns that follow-up.

The controlling parent resumes a paused native child with an ordinary
`sessions_send` continuation. The runtime preserves the original task and its
completion recipient without requiring `mode: "resume"`. An explicit
`mode: "followup"` deliberately starts a separate turn instead. Return completed
work normally after resuming; yielding again keeps the task waiting.

An operator can also resume the existing child with the `sessions.send` Gateway
method and its paused session key. This preserves the original task, requester,
and parent completion batch, so the parent continues when the child finishes.

A background `exec` command cannot wake a yielded sub-agent. Collect its result
with `process` before yielding; the tool rejects a self-yield while that process
is running or its result is uncollected. If an older version left a child waiting
this way, resume that existing child with `sessions.send` and have it reconcile
the retained result. Elapsed time alone does not prove that its work completed.

Collector runs are the exception, because their result is collected explicitly
rather than announced. Where collector context reaches the tool factory, such as
the embedded runner, the turn is not offered `sessions_yield`, and if an override
ever reaches the tool, it returns an error explaining that collector results are
collected explicitly. Other paths do not pass that context yet: a CLI-backed
collector turn through the Gateway tool resolver can still be offered the tool
and receive a successful `yielded` result. In every case a collector that yields
is settled at its own terminal instead of pausing, so its waiter resolves rather
than blocking for good.

The registry also continues a yielded sub-agent when its announced children
settle, including an orchestrator spawned by cron. That internal settlement
wake preserves the original requester and delivers the orchestrator's completion
there. Other follow-ups through routes not tracked as sub-agent runs neither
continue the paused run nor announce its requester. See
[Subagent yield handoff](/concepts/subagent-yield-handoff) for lifecycle ownership
and progress delivery after yield.

Among plugin runtime follow-ups, continuation applies to those that use default
delivery. A follow-up that supplies its own requester or completion-delivery
context is asking for its own audience, so it runs as a separate sibling and
delivers there instead. The paused run stays resumable, and a later default
follow-up still continues it.

When active children exist, OpenClaw injects a compact runtime-generated
`Active Subagents` prompt block into normal turns so the requester can see
the current child sessions, run ids, statuses, labels, tasks, and
`taskName` aliases without polling. The task and label fields in that
block are quoted as data, not instructions, because they can originate
from user/model-provided spawn arguments.

Later turns also include `Recently Completed Subagents`, capped at the eight
newest children that ended in the last 30 minutes. This lists execution metadata,
not an acknowledgment of result delivery.

`Child results awaiting delivery` carries retained completion obligations for
the requester or controller session, even when the child ended more than 30
minutes ago, a newer execution exists, or the current turn cannot spawn. It
includes at most eight results, oldest first, with each result limited to 2,000
characters. Omitted entries and truncated results are marked. Result text is
quoted as data. Reading this context does not acknowledge or retry delivery.

## Tool: `subagents`

Lists spawned sub-agent runs and background-task records owned by the
requester session tree. The task rows cover native sub-agents, ACP runs,
Gateway CLI/media work, and cron executions. It is scoped to the current
requester; a child can only see its own controlled children.

Use `subagents` for on-demand status and debugging. Use `sessions_yield` to
wait for completion events in a later turn. Use `action: "wait"` when the
immediate next step needs one or more specific tasks within the current turn.

`action: "wait"` accepts `taskIds` from the task rows returned by `list`
(1–32 IDs), plus `timeoutSeconds` (0–60, default 30). It returns when any
selected task completes or needs approval/user input, or a selected task
becomes unavailable. `reason` identifies `completed`, `attention`,
`unavailable`, or `timeout`; `tasks` contains the current authorized snapshots.
A zero timeout reads a snapshot. Waiting does not cancel tasks, consume their
completion announcements, or change the requester's delivery ownership.
Cancelling the waiting turn also leaves those tasks running. The task IDs
remain stable when a yielded child resumes under a new execution run ID.

Structured list entries separate `execution` from task outcome and
`deliveryStatus`. A yielded child remains active even after its last execution
ended: `execution.wait` identifies the currently pending announcing children,
or reports `external` when no such child owns the next continuation. External
means the runtime has no child completion to await; it does not prove that a
remote job or timer was scheduled. Child dependency lists are bounded to 32
entries and `pendingCount` retains the total. A finished child with pending
delivery has produced a result that has not yet reached its requester.
For an external wait, the controlling parent can send a continuation to the
listed child session key with `sessions_send`; merely yielding does not schedule
one. The task owner delivers completion when the resumed child finishes.

Use `action: "cancel"` with a `taskId` returned by `action: "list"` to stop
a task. Native subagent cancellation requires current controller authority;
retained task history and completion-recipient read/wait access do not grant
that control. A leaf sub-agent cannot cancel work owned by another session.

A canonical ACP task's recorded owner retains cancellation of its own exact
execution after a session-parent change. Core task cancellation refuses retained ACP tasks
without execution-instance metadata; select the current task or use ACP session
controls instead. Control over descendants follows the child's current
spawning session, or its current parent when no spawning session is recorded.
Moving a normally spawned child's navigation parent does not transfer descendant
control.

Messages and control have distinct effects. `sessions_send` with
`mode: "steer"` injects guidance into an active supported run and rejects an
idle target. `mode: "followup"` starts or queues another turn without steering.
`mode: "notify"` only queues context for the target's next turn, returning
`status: "queued"`, `durability: "process"`, and `runStarted: false`; it neither
wakes the target nor proves the message was read. This uses the existing
bounded system-event queue: notifications do not survive a Gateway restart,
and older queued events can be evicted when the queue fills. Exact-incarnation
access grants cannot enqueue notifications beyond their lifetime. Omitting
`mode` preserves automatic routing. Its
`targetDisposition` describes admission, while its `delivery.status` describes
the later reply announcement. Neither proves completion. At the Gateway,
`chat.send` with `queueMode: "steer"` gives guidance at the supported runtime
boundary; `queueMode: "interrupt"` replaces active execution. The deprecated
`sessions.steer` RPC retains its documented interrupt behavior. An operator's
`sessions.send` to a paused native child resumes its existing task and original
completion audience. Use cancellation when the task itself should stop.
