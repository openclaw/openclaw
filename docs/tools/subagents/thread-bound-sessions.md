---
summary: "Sub-agent routing policy, user-owned ACP bindings, allowlists, discovery, and auto-archive rules"
title: "Sub-agent routing and lifecycle"
read_when:
  - You need to understand why sub-agents cannot bind conversations
  - You need the per-agent spawn allowlist or agents_list discovery rules
  - You need to know when a sub-agent session is archived
---

## Scope

This restriction applies to external chat channels, including DMs, groups,
threads, and topics. It does not disable independent Team/Web UI sessions or
internal session coordination. Ordinary channel threads continue to belong to
the channel-facing agent; delegated workers return their results to that agent.

## Thread-bound sessions

Sub-agents never own chat-channel conversation routing. Native sub-agents and agent-spawned
ACP children run in the background and return results to the parent/requester.
The parent reviews those results and owns the user-facing reply. There is no
manual command for binding a native sub-agent to a thread, topic, or chat.

The `sessions_spawn` tool does not offer `thread`; `mode: "session"` is accepted only as a legacy alias for a one-shot run. An older
call that passes `thread: true` or `mode: "session"` (also with
`runtime: "acp"`) still succeeds. The child runs as a one-shot background run
and reports back to the requester. The result `note` says that thread binding
is not available for agent-started spawns.

Saved legacy bindings to native sub-agents or agent-spawned ACP children are
ignored by runtime routing and delivery. OpenClaw does not migrate or delete
those saved bindings in a startup or background sweep. This also applies to
native sub-agent bindings that were originally created by a user command.

User-owned ACP sessions are separate: you can bind one explicitly with
`/acp spawn <harness> --thread auto` or `--bind here`, or configure a persistent
ACP binding. Ordinary channel threads and replies, including Discord's
thread creation and auto-thread replies, continue to work; a channel thread
is not a sub-agent binding.

### Thread supporting channels

Explicit user-owned ACP bindings are supported by **Discord**, **iMessage**,
**Matrix**, and **Telegram**. Placement depends on the adapter: Discord and
Matrix can create a child thread, while Telegram and iMessage support binding
the current conversation. See
[ACP bindings](/tools/acp-agents/bindings#current-conversation-binds).

`threadBindings.spawnSessions: false` blocks user-run `/acp spawn --thread`.
It does not prevent `--bind here` from binding the current conversation when
thread bindings are enabled.

### Quick flow

This is a user-owned ACP session, not a delegated sub-agent:

<Steps>
  <Step title="Spawn">
    In a supported channel, run `/acp spawn <harness> --thread auto`, or use `--bind here` for the current conversation.
  </Step>
  <Step title="Bind">
    OpenClaw binds the user-owned ACP session to the conversation chosen by the command and channel adapter.
  </Step>
  <Step title="Route follow-ups">
    Messages in the bound conversation go to that ACP session. Delegated workers still return through their parent.
  </Step>
  <Step title="Inspect timeouts">
    Use `/session idle` to inspect/update inactivity expiry and
    `/session max-age` to control the hard cap.
  </Step>
  <Step title="Detach">
    Use `/session unbind` to detach without closing the ACP session.
  </Step>
</Steps>

### Manual controls

These controls manage supported user-owned session bindings, not sub-agent bindings.

| Command            | Effect                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `/session unbind`  | Remove the current conversation binding without closing the agent session                 |
| `/agents`          | List active runs and binding state (`binding:<id>`, `unbound`, or `bindings unavailable`) |
| `/session idle`    | Inspect/update inactivity expiry for the current binding                                  |
| `/session max-age` | Inspect/update the maximum age of the current binding                                     |

### Config switches

- **Global default:** `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours` govern supported user-owned session bindings.
- **Channel override:** `channels.<id>.threadBindings.*`. `threadBindings.spawnSessions` controls user-run `/acp spawn --thread`. See [Thread supporting channels](#thread-supporting-channels) above.
- `threadBindings.defaultSpawnContext` is deprecated and ignored at every accepted config scope. The key remains accepted for existing installations. Native sub-agents start with isolated context unless the spawn explicitly passes `context: "fork"`.

See [Configuration reference](/gateway/configuration-reference) and
[Slash commands](/tools/slash-commands) for current adapter details.

### Allowlist

<ParamField path="agents.entries.*.subagents.allowAgents" type="string[]">
  List of configured agent ids that can be targeted via explicit `agentId` (`["*"]` allows any configured target). Default: only the requester agent. If you set a list and still want the requester to spawn itself with `agentId`, include the requester id in the list.
</ParamField>
<ParamField path="agents.defaults.subagents.allowAgents" type="string[]">
  Default configured target-agent allowlist used when the requester agent does not set its own `subagents.allowAgents`.
</ParamField>
<ParamField path="agents.defaults.subagents.requireAgentId" type="boolean" default="false">
  Block `sessions_spawn` calls that omit `agentId` (forces explicit profile selection). Per-agent override: `agents.entries.*.subagents.requireAgentId`.
</ParamField>
<ParamField path="agents.defaults.subagents.announceTimeoutMs" type="number" default="120000">
  Timeout for gateway `agent` announcement handoff attempts. Once a handoff is accepted, waiting for the parent session's turn does not consume this budget. After execution starts, the requester's normal [runtime timeout and cancellation controls](/concepts/agent-loop#timeouts) apply; the announcement timer does not restart. Values are positive integer milliseconds and are clamped to the platform-safe timer maximum. Queue waits, requester execution, and transient retries can make total delivery time longer than one configured timeout.
</ParamField>

If the requester session is sandboxed, `sessions_spawn` rejects targets
that would run unsandboxed.

### Discovery

Use `agents_list` to see which agent ids are currently allowed for
`sessions_spawn`. The response includes each listed agent's effective
model and embedded runtime metadata so callers can distinguish OpenClaw, Codex
app-server, and other configured native runtimes.

`allowAgents` entries must point at configured agent ids in `agents.entries.*`.
`["*"]` means any configured target agent plus the requester. If an agent config
is deleted but its id remains in `allowAgents`, `sessions_spawn` rejects that id
and `agents_list` omits it. Run `openclaw doctor --fix` to clean stale
allowlist entries, or add a minimal `agents.entries.*` entry when the target should
remain spawnable while inheriting defaults.

### Auto-archive

- Sub-agent sessions are automatically archived after `agents.defaults.subagents.archiveAfterMinutes` (default `60`).
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` archives immediately after announce (still keeps the transcript via rename).
- Auto-archive is best-effort; pending timers are lost if the gateway restarts.
- Configured run timeouts do **not** auto-archive; they only stop the run. The session remains until auto-archive.
- Auto-archive applies equally at every sub-agent depth.
- Browser cleanup is separate from archive cleanup: tracked browser tabs/processes are best-effort closed when the run finishes, even if the transcript/session record is kept.

If a newer run takes over the same session, the older run stops claiming tabs for
cleanup. Cleanup already admitted for a tab still settles against that tab's
captured ownership; it does not remove a later registration.

The `subagent_ended` plugin hook is best-effort. Hook execution or plugin runtime
loading failures are logged and do not abort sub-agent cleanup.
