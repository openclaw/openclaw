---
summary: "Context modes and the sessions_spawn, sessions_yield, and subagents tool contracts"
title: "Sub-agent tool reference"
read_when:
  - You are calling sessions_spawn and need its parameters
  - You need to choose between isolated and forked child context
  - You are waiting for child results with sessions_yield
---

## Context modes

Non-thread native sub-agents start isolated unless the caller explicitly asks
to fork the current transcript. Thread-bound spawns follow
`threadBindings.defaultSpawnContext`, which defaults to `fork`. Pass
`context: "isolated"` explicitly when the child must start with clean context.

| Mode       | When to use it                                                                                                                         | Behavior                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `isolated` | Fresh research, independent implementation, slow tool work, or anything that can be briefed in the task text                           | Creates a clean child transcript. Default for non-thread spawns; keeps token use lower. |
| `fork`     | Work that depends on the current conversation, prior tool results, or nuanced instructions already present in the requester transcript | Branches the requester transcript into the child session before the child starts.       |

Use `fork` sparingly. It is for context-sensitive delegation, not a
replacement for writing a clear task prompt.

## Tool: `sessions_spawn`

Starts a sub-agent run on the global `subagent` lane. Ordinary one-shot runs
use `deliver: false` and return through an announce step; collectors, quiet
runs, and direct thread replies use the
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

- **Model:** native sub-agents inherit the caller unless you set `agents.defaults.subagents.model` (or per-agent `agents.entries.*.subagents.model`). ACP runtime spawns use the same configured subagent model when present; otherwise the ACP harness keeps its own default. An explicit `sessions_spawn.model` still wins.
- **Thinking:** native sub-agents inherit the caller's active turn, including one-shot thinking overrides, unless you set `agents.defaults.subagents.thinking` (or per-agent `agents.entries.*.subagents.thinking`). ACP runtime spawns also apply `agents.defaults.models["provider/model"].params.thinking` for the selected model. An explicit `sessions_spawn.thinking` still wins.
- **Run timeout:** pass `runTimeoutSeconds` to set a timeout for a specific native, ACP, or visible sub-agent run. When omitted, OpenClaw uses `agents.defaults.subagents.runTimeoutSeconds` if configured; otherwise it falls back to `0` (no timeout). An explicit `0` disables the timeout for that run.
- **Process lifetime:** a detached OpenClaw sub-agent has its own run lifecycle. A background task created inside an external CLI backend is different: it shares the parent CLI subprocess and stops if that parent reaches `agents.defaults.timeoutSeconds`.
- **Task delivery:** native sub-agents receive their delegated task in a `[Subagent Task]` message appended after any forked history. Inherited task envelopes are context, not the current child's assignment. The sub-agent system prompt carries runtime rules and routing context, not a hidden duplicate of the task.

Accepted native sub-agent spawns report their actual initialized `context`
(`fork` or `isolated`), including `isolated` when a requested fork exceeds the
parent-context size cap. They also include resolved child model metadata:
`resolvedModel` contains the applied model ref and `resolvedProvider` contains
the provider prefix when the ref has one.

### Delegation prompt mode

`agents.defaults.subagents.delegationMode` controls prompt guidance only; it does not change tool policy or enforce delegation. With no explicit setting, OpenClaw uses `prefer` in each agent's main session and `suggest` in every other session.

- `suggest`: keep the standard prompt nudge to use sub-agents for larger or slower work.
- `prefer`: tell the agent to stay responsive and delegate anything more involved than a direct reply through `sessions_spawn`.

An explicit default or per-agent setting always wins, including `suggest` in a main session and `prefer` elsewhere. Per-agent overrides use `agents.entries.*.subagents.delegationMode`.

In `prefer` mode, hidden sub-agents are for internal legwork that the user does not need to follow. Work the user will watch or return to, or work with its own deliverable such as a URL, PR, or report, should use `sessions_spawn` with `visible: true` so it remains in the sidebar.

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
  Optional short task title shown in UI lists (task ledger, session sidebar). Name the work being done, not the agent; it is set on the child session at run start.
</ParamField>
<ParamField path="agentId" type="string">
  Spawn under another configured agent id when allowed by `subagents.allowAgents`.
</ParamField>
<ParamField path="cwd" type="string">
  Optional task working directory for the child run. Native sub-agents still load bootstrap files from the target agent workspace; `cwd` only changes where runtime tools and CLI harnesses do the delegated work. For visible sessions, paths outside configured agent workspaces require `operator.admin`. With `worktree: true`, omitting `cwd` inherits the same-agent parent's managed repository when available; otherwise the target agent workspace is used.
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
  When `true`, requests channel thread binding for this sub-agent session.
</ParamField>
<ParamField path="mode" type='"run" | "session"' default="run">
  If `thread: true` and `mode` is omitted, default becomes `session`. `mode: "session"` requires `thread: true`.
  If thread binding is unavailable for the requester channel, use `mode: "run"` instead.
  With `visible: true`, omit `mode` or use the default `"run"`; the visible session remains persistent. `mode: "session"` is unavailable on this path.
</ParamField>
<ParamField path="cleanup" type='"delete" | "keep"' default="keep">
  `"delete"` archives the session immediately after announce (still keeps the transcript via rename).
</ParamField>
<ParamField path="expectsCompletionMessage" type="boolean" default="true">
  Set `false` for fire-and-forget children. When the child finishes, OpenClaw skips the completion handoff to the requester (no announce or steer turn), records the delivery as not required, and still runs child cleanup. Inspect such children with `subagents` or `sessions_history`. `collect: true` always uses `false`.
</ParamField>
<ParamField path="sandbox" type='"inherit" | "require"' default="inherit">
  `require` rejects the spawn unless the target child runtime is sandboxed.
</ParamField>
<ParamField path="context" type='"isolated" | "fork"'>
  `fork` branches the requester's current transcript into the child session. Native sub-agents only. Non-thread spawns default to `isolated`; thread-bound spawns follow `threadBindings.defaultSpawnContext`, which defaults to `fork`. Pass `isolated` explicitly to guarantee clean context. All native forks, hidden or visible, must target the same agent as the requester.
</ParamField>
<ParamField path="visible" type="boolean" default="false">
  Create a persistent dashboard session for work the user will watch or return to, or when they ask for a thread. Visible spawns support only `runtime: "subagent"` and always keep the created session.
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

With `visible: true`, `group`, `model`, `cwd`, and a same-agent `context: "fork"` are supported. Use this durable mode for coding, multi-step work, or results the user or parent may revisit, steer, or keep; it appears in the sidebar when the web UI is available and still works without it. Pass `group` to place the new session in that sidebar group atomically; omitted or blank values leave it ungrouped. A sandboxed target restricts `cwd` to that agent's workspace. Non-admin callers may use `cwd` only inside a configured agent workspace. With `worktree: true`, omitting `cwd` inherits the same-agent parent's live managed repository and creates a separate worktree. Other spawns use the target agent workspace; for another repository, ask the operator to start the session from a registered project. Do not replace a rejected persistent spawn with the synchronous `openclaw agent` CLI, whose command deadline defaults to 600 seconds. Thread binding, `mode: "session"`, thinking overrides, `lightContext`, and attachment staging are unavailable on this path because visible sessions are persistent dashboard sessions created through `sessions.create`. The default `mode: "run"`, empty `attachments`, and an empty `attachAs.mountPath` are accepted without changing that behavior. The new dashboard child inherits the requester's effective tool-policy ceiling before its first turn. Session listing and addressing obey `tools.sessions.visibility`; the default `all` scope covers sessions across agents on the Gateway for unsandboxed callers. Cross-agent access is on by default and governed by `tools.agentToAgent`; use `allow` to restrict agent pairs or set `enabled: false` to block ordinary cross-agent access (requester-owned native subagent and ACP child sessions stay reachable under `tree` or `all`). Set `agent` for same-agent-only access, `tree` for current plus spawned scope (main retains its same-agent exception), or `self` for current-session-only access. Sandbox spawned-only clamps still apply. Cross-agent owned children are included by `tree`, not `agent`; preserve explicit `tree` for that workflow. See [Session tools](/concepts/session-tool#visibility) and [Managed worktrees](/concepts/managed-worktrees).

If a call fails with `Parameters require visible=true`, omit the named group or worktree options to keep the hidden or ACP runtime. To create a visible session instead, use `visible: true` with `runtime: "subagent"` and omit `mode`, `thread`, `thinking`, `lightContext`, `attachments`, `attachAs`, swarm options, and the ACP-only `streamTo` and `resumeSessionId`. Worktree names and base refs also require `worktree: true`. Adding `visible: true` alone does not make an ACP call compatible.

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

Use the optional `message` field for private context that the resumed turn
should receive. Use `acknowledgment` for a waiting reply when an interactive
parent turn would otherwise end silently. The acknowledgment is not sent from
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

A sub-agent can also yield on its own behalf to wait for external work, such
as a remote job or a long-running task it does not drive itself. That pauses
the child run instead of completing it, so the requester receives no
completion event yet and keeps waiting. A plugin can then continue that same run
by calling `api.runtime.subagent.run` with the paused `sessionKey`, instead of
starting a sibling. The requester is announced once such a follow-up finishes
normally; a follow-up that yields again leaves the run paused and the requester
waiting.

The registry also continues a yielded sub-agent when its announced children
settle, including an orchestrator spawned by cron. That internal settlement
wake preserves the original requester and delivers the orchestrator's completion
there. Ordinary follow-ups through routes not tracked as sub-agent runs neither
continue the paused run nor announce its requester. See
[Subagent yield handoff](/concepts/subagent-yield-handoff) for lifecycle ownership
and the remaining boundary for channel progress after yield.

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

## Tool: `subagents`

Lists spawned sub-agent runs and background-task records owned by the
requester session tree. The task rows cover native sub-agents, ACP runs,
Gateway CLI/media work, and cron executions. It is scoped to the current
requester; a child can only see its own controlled children.

Use `subagents` for on-demand status and debugging. Use `sessions_yield` to
wait for completion events.

Use `action: "cancel"` with a `taskId` returned by `action: "list"` to stop
a task. Cancellation is confined to the controlled session tree; a leaf
sub-agent cannot cancel work owned by another session.
