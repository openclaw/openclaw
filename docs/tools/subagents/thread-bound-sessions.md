---
summary: "Start a sub-agent in a new thread with /subagents spawn --thread, plus the allowlist, discovery, and auto-archive rules"
title: "Thread-bound sub-agent sessions"
read_when:
  - You are implementing or troubleshooting thread-bound subagent sessions
  - You need the per-agent spawn allowlist or agents_list discovery rules
  - You need to know when a sub-agent session is archived
---

## Thread-bound sessions

Only you can bind a sub-agent to a thread. An agent cannot.

- **Agent-started spawns never bind.** This applies to native sub-agents and
  ACP sessions, on every channel. The child runs in the background, and its
  result returns to the agent that started it. The chat where you talk to your
  agent stays with that agent.
- **You start a thread-bound sub-agent with a command:**
  `/subagents spawn --thread [--agent <id>] <task>`. OpenClaw creates a **new**
  thread or topic and binds a persistent sub-agent session to it. The
  conversation where you ran the command does not change.

The `sessions_spawn` tool does not offer `thread` or `mode: "session"`. An older
call that passes `thread: true` or `mode: "session"` (also with
`runtime: "acp"`) still succeeds. The child runs as a one-shot background run
and reports back to the requester. The result `note` says that thread binding
is not available for agent-started spawns.

On upgrade, OpenClaw removes the bindings that older agent spawns put on your
own chat. It does this when the gateway starts and when each channel account
starts. Bindings that a user made (`/subagents spawn --thread`, `/acp`) stay.

### Thread supporting channels

`/subagents spawn --thread` needs a channel that can create a child thread or
topic:

- **Discord** channels
- **Matrix** rooms
- **Telegram** forum groups (topics)

In a DM, or in a group that cannot hold threads (such as a Telegram group that
is not a forum), the command stops with a clear message and starts nothing.

`threadBindings.spawnSessions: false` blocks `/subagents spawn --thread` and
`/acp spawn --thread`.

User-started ACP bindings, such as `/acp spawn <harness> --bind here` or
`--thread auto`, also work on **iMessage**. See
[ACP bindings](/tools/acp-agents/bindings#current-conversation-binds).

### Quick flow

<Steps>
  <Step title="Spawn">
    In a Discord channel, Matrix room, or Telegram forum group, run `/subagents spawn --thread <task>`. Add `--agent <id>` to use another allowed agent.
  </Step>
  <Step title="Bind">
    OpenClaw creates a new thread or topic and binds a persistent sub-agent session to it. The sub-agent answers in that new thread.
  </Step>
  <Step title="Route follow-ups">
    Messages you send in the new thread go to the sub-agent. The conversation where you ran the command stays with your agent.
  </Step>
  <Step title="Inspect timeouts">
    Use `/session idle` to inspect/update inactivity expiry and
    `/session max-age` to control the hard cap.
  </Step>
  <Step title="Detach">
    Use `/session unbind` to detach without closing the agent session.
  </Step>
</Steps>

### Manual controls

| Command            | Effect                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `/session unbind`  | Remove the current conversation binding without closing the agent session                 |
| `/agents`          | List active runs and binding state (`binding:<id>`, `unbound`, or `bindings unavailable`) |
| `/session idle`    | Inspect/update inactivity expiry for the current binding                                  |
| `/session max-age` | Inspect/update the maximum age of the current binding                                     |

### Config switches

- **Global default:** `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours`.
- **Channel override:** `channels.<id>.threadBindings.*`. `threadBindings.spawnSessions` controls `/subagents spawn --thread` and `/acp spawn --thread`. See [Thread supporting channels](#thread-supporting-channels) above.
- `threadBindings.defaultSpawnContext` sets the default context for sub-agents started with `/subagents spawn --thread` (`"fork"` by default). Agent-started spawns start with isolated context unless the spawn passes `context: "fork"`.

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
