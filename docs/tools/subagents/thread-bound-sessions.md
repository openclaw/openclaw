---
summary: "Bind a sub-agent to a channel thread, and the allowlist, discovery, and auto-archive rules"
title: "Thread-bound sub-agent sessions"
read_when:
  - You are implementing or troubleshooting thread-bound subagent sessions
  - You need the per-agent spawn allowlist or agents_list discovery rules
  - You need to know when a sub-agent session is archived
---

## Thread-bound sessions

When thread bindings are enabled for a channel, a spawned sub-agent can get
its own new thread. Follow-up user messages in that thread keep routing to the
same sub-agent session, while the conversation you spawned it from stays with
your agent.

### Thread supporting channels

`sessions_spawn` with `thread: true` always opens a new child thread; it never
hands the current conversation to the worker. Bundled channels that can open
one: **Discord** and **Matrix**. On channels that would bind the current
conversation instead (for example Telegram, iMessage, Feishu, and LINE),
`thread: true` is rejected; spawn with `mode: "run"` and the result is
announced back to the conversation. Use the per-channel `threadBindings` config
keys for enablement, timeouts, and `spawnSessions`.

Worker bindings created by older versions on the current conversation are
ignored: messages there route to your agent again, and the stale binding
expires through its normal idle timeout. To hand a conversation to an ACP
session deliberately, use `/acp spawn --bind here`.

### Quick flow

<Steps>
  <Step title="Spawn">
    `sessions_spawn` with `thread: true` (and optionally `mode: "session"`).
  </Step>
  <Step title="Bind">
    OpenClaw opens a new child thread in the active channel and binds it to that session.
  </Step>
  <Step title="Route follow-ups">
    Replies and follow-up messages in that thread route to the bound session.
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
- **Channel override and spawn auto-bind keys** are adapter-specific. See [Thread supporting channels](#thread-supporting-channels) above.

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
