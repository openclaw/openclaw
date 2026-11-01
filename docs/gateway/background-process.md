---
summary: "Background exec execution and process management"
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
title: "Background exec and process tool"
---

OpenClaw runs shell commands through the `exec` tool. Ordinary long-running tasks stay in memory; opt-in [durable processes](/gateway/background-process#durable-processes) on a Linux Gateway retain ownership across Gateway restarts. The `process` tool manages background sessions from gateway, sandbox, and worker-local execution. Remote `host=node` calls use synchronous `system.run` and never create a process session, even when `process` is enabled.

## exec tool

Parameters:

| Parameter        | Description                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`        | Required. Shell command to run.                                                                                                                                   |
| `workdir`        | Working directory; omit to use the default cwd.                                                                                                                   |
| `env`            | Extra environment variables for the command.                                                                                                                      |
| `yieldMs`        | Milliseconds before returning a handle for an ordinary command (default 10000).                                                                                   |
| `background`     | Start a deliberately independent service immediately.                                                                                                             |
| `durable`        | Survive Gateway restarts using a Linux systemd user service; requires explicit `background: true` or `yieldMs`.                                                   |
| `timeoutSeconds` | Timeout in seconds (default `tools.exec.timeoutSeconds`); kills the process on expiry. Set `timeoutSeconds: 0` to disable the exec process timeout for that call. |
| `pty`            | Run in a pseudo-terminal when available (TTY-required CLIs, coding agents).                                                                                       |
| `elevated`       | Run outside the sandbox if elevated mode is enabled/allowed (`gateway` by default, or `node` when the exec target is `node`).                                     |
| `host`           | Exec target: `auto`, `sandbox`, `gateway`, or `node`.                                                                                                             |
| `node`           | Node id/name, used with `host: "node"`.                                                                                                                           |

Behavior:

- Foreground runs return retained output directly and disclose when earlier output exceeded the aggregate cap.
- Set `awaitResults: true` when a command result is needed to finish the task. It stays an owned tool call through process settlement and terminal collection instead of returning an uncollected background handle. This works with `notifyOnExit=false`; no completion notification is enabled. `awaitResults: true` cannot be combined with `background: true`, which explicitly selects an independently running service. Run, tool, and process deadlines still apply. In OpenClaw Code Mode, the cell retains required calls and resumes on their settlement without model polling.
- When backgrounded (explicit or via `yieldMs` timeout), the tool returns `status: "running"` + `sessionId` and a short output tail. On the Gateway and in its sandbox, a yielded handle does not make an ordinary command independent: the browser's **Stop** button and typed `/stop` cancel the selected request's commands. Stop waits for process cleanup and reports when cleanup could not be confirmed. Completed output remains available, and canceled commands do not emit a new completion notification. Managed workers retain the separate behavior described below.
- Use `background: true` only for a deliberately independent service. Request Stop leaves that service running; use its process handle to stop it separately. Normal turn completion also preserves ordinary commands that are still running.
- Launch failures return the operating-system error and release worker cleanup even when no process starts.
- Native Windows command shells retain `SystemRoot` when launched with a replacement environment, including on ARM64. Other omitted variables stay absent, and an explicitly supplied `SystemRoot` takes precedence.
- Managed sandbox workspace finalization bounds each container inspection, pause, and resume command to 30 seconds. A failed or timed-out operation preserves its recovery receipt rather than treating an uncertain pause or resume as successful.
- Backgrounded and `yieldMs` runs inherit `tools.exec.timeoutSeconds` unless the call passes an explicit `timeoutSeconds`.
- With the [secret egress proxy](/gateway/secrets#secret-egress-proxy) enabled, each non-durable Gateway-hosted command retains its own proxy access across turns. Process exit, cancellation, timeout, or Gateway shutdown revokes that access and closes its connections. Use `process kill` to stop a background command and its proxy access together.
- Returning a background session ID does not stop the process timeout. For a persistent service on the gateway or in a sandbox, use `background: true` with `timeoutSeconds: 0`, then stop it with `process` action `kill` when finished. Host and worker lifecycle limits still apply.
- Output stays in memory up to the per-session aggregate cap until the session is polled or cleared.
- Finished sessions expire after their configured TTL, measured from completion. Each exec captures its agent's retention setting when admitted; using another agent's process tool does not change existing results' lifetimes. The registry also retains at most 50 finished sessions and 2,000,000 total retained output characters, evicting the oldest records first. The newest completed session retains its capped per-session aggregate even when that record alone exceeds the global limit.
- Remote `host=node` execution ignores `background`/`yieldMs`. Explicit `background: true` or `yieldMs` requests produce a warning with the execution result, not while approval is pending. The call returns output without a process `sessionId`.
- If the `process` tool is disallowed, local `exec` also runs synchronously and ignores `yieldMs`/`background`.
- Spawned exec commands receive `OPENCLAW_SHELL=exec` for context-aware shell/profile rules.
- For long-running work that starts now: start it once. Automatic completion wake (when enabled) can happen after the command exits. New output while it is still running does not start another turn. Ending the turn does not stop the command; use `process kill` when it is no longer needed. Completion and the configured timeout still apply; background exec is not a saved, restartable automation.

- A completion wake lets the agent continue outstanding work; it does not require a new chat message. The agent is instructed to report requested results not yet delivered, meaningful outcome changes, or new actionable failures, and stay silent for routine, duplicate, superseded, or already-recovered results. A completion without captured output, such as a command that redirected its output to a file, continues the same way, so the agent can read that file and report. This is a model instruction, not a rule-based notification filter, and it does not disable the completion turn. A silent completion turn is valid in every conversation, including Control UI chats; subagent runs still require a final result.
- Raw exec completion notices stay in the agent's transcript but are hidden from the Control UI's chat history and live message updates. The agent's user-facing reply remains visible.
- A host command started in a chat conversation completes through ordinary execution in that conversation: the completion turn runs with its session history, and any reply goes back to the captured account, chat, and topic. It waits behind existing work in that session, independently of heartbeat cadence, active hours, and delivery settings. A command started in an automatically silent run keeps that restriction for its completion. Current session permissions and tool restrictions can tighten the captured permissions before execution.
- Before a Gateway restart, when a channel owner started the command, its completion turn keeps that owner's owner-only tools, such as `openclaw` and `gateway`, so the agent can finish the task without a new message. OpenClaw rechecks owner status against the current config each time; if the sender is no longer an owner, the tools stay unavailable. Commands started by other senders do not inherit those owner-only tools. After restart, durable outcomes use the owning session principal's current authority as described below.
- Isolated cron exec completions stay on the originating run's session, including jobs with `delivery.mode: "announce"`. They never wake the agent main session. A completion accepted while that run is active waits for it to finish before starting a follow-up turn. Completions not yet accepted when the originating run ends cannot start another turn; retained output remains available through `process poll` or `process log`. Jobs with `delivery.mode: "none"` keep automatic completion wakes disabled. The cron job's normal announcement delivery is unchanged.
- A failed background command wakes its originating session even when other sessions or automations are busy. If that session is still running, the completion waits until it is free. This also applies when a watcher exits before the work it was watching finishes.
- Ordinary Gateway-hosted background processes still end with the Gateway, and their in-memory handles and requester continuations are not restored after restart. Use `durable: true` on a supported Linux Gateway when the physical process must survive. Check saved output and side effects before repeating work whose outcome is unknown.
- Timeouts also wake the session when the command produced no output. The completion includes retry-safety guidance: verify any external side effects before retrying.
- Manually canceled commands do not trigger completion notifications, even when they produced output. Retained output remains available through `process poll` or `process log`. Cleanup failures from `process kill` still notify; request Stop reports cleanup failures through its error response without starting a completion turn.
- Request Stop also retires the ordinary command's queued or running completion turn, including after its retained process output expires. A stopped continuation cannot deliver a late reply or retry itself. Unrelated queued events and later human requests remain eligible to run.
- If automatic completion wake is unavailable, or you need quiet-success confirmation where empty successes do not wake (`tools.exec.notifyOnExitEmptySuccess`), poll with `process`.
- Background exec does not automatically wake subagent sessions. A subagent must collect its command result with `process poll` before yielding without another completion source. A requested stop also needs its terminal result collected.
- A quiet foreground command with an unexpired execution allowance is reported as long-running. Once that allowance expires, stalled-session recovery can abort the owning run. Repeated `process poll` or `process log` calls with unchanged output count toward loop detection; elapsed idle time alone is not progress.
- Don't emulate reminders or delayed follow-ups with `sleep` loops or repeated polling — use cron for future work.

### Env overrides

| Variable                                 | Effect                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_BASH_YIELD_MS`                 | Default yield before backgrounding (ms). Default 10000, clamped 10-120000.                                       |
| `OPENCLAW_BASH_MAX_OUTPUT_CHARS`         | In-memory aggregate cap in characters. Default 200000, clamped 1000-200000.                                      |
| `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` | Pending stdout/stderr cap per stream. Default 30000, clamped 1000-200000 and limited by the aggregate cap.       |
| `OPENCLAW_BASH_JOB_TTL_MS`               | TTL for finished sessions (ms), bounded to 1m-3h.                                                                |
| `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`    | Idle-output threshold before writable background sessions are marked as likely waiting for input. Default 15000. |

### Config (preferred over env overrides)

| Key                                   | Default | Effect                                                                                                              |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `tools.exec.backgroundMs`             | 10000   | Same as `OPENCLAW_BASH_YIELD_MS`.                                                                                   |
| `tools.exec.timeoutSeconds`           | 1800    | Default per-call timeout.                                                                                           |
| `tools.exec.cleanupMs`                | 1800000 | Same as `OPENCLAW_BASH_JOB_TTL_MS`.                                                                                 |
| `tools.exec.notifyOnExit`             | true    | Continue backgrounded host exec through an ordinary turn in its originating session on exit.                        |
| `tools.exec.notifyOnExitEmptySuccess` | false   | Also enqueue completion events for successful backgrounded runs with no output. Defaults to true for chat channels. |

### Disable automatic completion turns

Background exec completion notifications are enabled by default. They can run a
model turn marked `[OpenClaw exec completion]` even when recurring automation
jobs are disabled. A periodic schedule does not own completion follow-ups.

To keep background commands running without automatic completion turns, set:

```bash
openclaw config set tools.exec.notifyOnExit false
```

An agent's `agents.entries.<id>.tools.exec.notifyOnExit` overrides the global
setting. Set that override to `false` too, or remove it to inherit the global
value. Newly started commands use the updated setting; commands already running
retain the setting they started with. Durable restart wakes also check the current setting,
so disabling notifications suppresses any pending durable completion or lost-process wake. Use `process poll` or `process log` to
collect their results on demand. This disables the completion event and its
automatic model call without disabling `background: true` or the `process` tool.

For an active process, a successful `process kill` result acknowledges the cancellation request. Its
`cancellationRequested: true` and `terminationConfirmed: false` fields mean that
exit and backend cleanup still need confirmation. Use `process poll` until the
terminal result arrives, and report any cleanup failure. `process remove` also
hides the process record immediately, so use `kill` followed by `poll` when you
need to verify a stop. Stopping a saved automation does not cancel separate
ordinary processes created while preparing it; stop related process IDs too,
while leaving unrelated work running.

### Durable processes

Set `durable: true` together with explicit `background: true` or `yieldMs` to keep
Gateway-hosted work alive across Gateway restarts:

```json
{ "tool": "exec", "command": "npm run build", "background": true, "durable": true }
```

This requires Linux, systemd 250 or newer, and a reachable user manager for the Gateway's user,
with `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` available. The `process` tool
must be enabled. Sandbox, remote `host=node`, worker, macOS, and Windows execution
are unsupported. An unavailable requirement produces an error; durable execution
never silently falls back to ordinary background execution. OpenClaw does not
enable linger or keep the user manager alive after logout. A host reboot or user
manager shutdown still ends transient services; this is not a saved automation or
an automatic command-restart policy.

The existing background-process registry remains the owner. It launches a transient
`openclaw-proc-<opaque id>` user service outside the Gateway's cgroup. The unit uses
`ExitType=cgroup`: descendants keep the service running after its initial shell
exits, and completion waits until the cgroup is empty. `KillMode=control-group`
lets `process kill` stop the entire tree through `systemctl --user stop`.
Durable commands have no interactive input: `pty: true`
and `awaitResults: true` are refused, as are `process write`, `send-keys`, `submit`,
and `paste`. Exec security policy, approvals, managed environment preparation, cwd
restrictions, and process timeouts remain in effect. `timeoutSeconds` maps to
`RuntimeMaxSec`; `timeoutSeconds: 0` disables that lifetime bound. The ordinary
host-exec memory calculation supplies `MemoryMax`, enforced by the unit's cgroup
instead of the sampled watchdog. Durable processes do not block safe Gateway
restart or cooperative suspension. Ordinary background processes retain their
existing restart and suspension behavior.

Durable commands launch without [secret-egress proxy](/gateway/secrets#secret-egress-proxy)
grants, secret-store sentinels, or proxy environment because those grants end with
the Gateway. The exec result reports how many credentials were omitted; no grant
or binding is persisted. For commands that need credentials, use the managed
GitHub identity, the command's own configuration, or non-durable background
execution. A [managed GitHub identity](/gateway/config-tools/github-identity) remains available:
its direct credential and Git author environment are bound at launch. Running
commands retain that token without refresh, so a very long process can outlive a
short-lived credential.

Stdout and stderr append to a per-process log under
`$OPENCLAW_STATE_DIR/processes/`. A small ownership row in the
[shared state database](/reference/database-schemas/layout#durable-background-processes)
records the process, owning agent and session generation, unit identity, cwd, log
path, start time, notification policy, and terminal outcome. It contains no
environment values, credentials, command arguments, or output. After restart, the
displayed command is a generic summary rather than the original command text.
Logs are named local artifacts and can contain whatever the command prints. The
in-memory output caps do not limit a running command's log file size.

On Gateway startup, the registry adopts persisted records under the same process
IDs and session scope. Live units become tracked background sessions again, so
`process list`, `poll`, `log`, and `kill`, along with the Processes panel, use the
same registry observations. The registry reads a bounded log tail into its normal
output buffers and checks unit state through its existing observation owner. A
unit that exited while the Gateway was down retains its real exit status until
the registry records it and cleans up the unit. A missing unit is recorded as a
lost process with an unknown outcome; check saved output and side effects before
repeating work. Adoption never re-executes the command.

An adopted completion or lost-process outcome is new system input to the owning
session under that session principal's current authority. OpenClaw does not
restore the original requester or operator continuation. Reset or archived
sessions, incognito sessions, subagents, ended cron runs, and disabled completion
notifications receive no restart wake. Empty successful outcomes follow the
captured `notifyOnExitEmptySuccess` policy. Before restart, ordinary live-requester
completion behavior stays unchanged. Completed durable records and their logs
expire under the captured completion-relative retention setting and normal
registry limits; restarting does not renew retention.

## Worker environments

For managed background work on a paired device, enable [session hosting](/nodes/session-hosting) and select that device for an OpenClaw session. Use the worker's local `exec` with `background: true` and its `process` tool when permitted by the session's tool and exec policy. This runs the session on the device instead of sending individual remote `host=node` commands.

On a paired-node or node-backed cloud worker, background processes belong to the
session's environment. Finishing a turn leaves already-backgrounded commands running.
A later turn in the same environment can use `process` to poll, send input, or stop
them. Cancelling an active worker turn also stops its retained background commands
and releases the worker after process cleanup completes.

The retained worker occupies one node worker slot. Reusing it needs no additional
slot. If a command finishes between turns, its retained output remains available
to the next turn, subject to the normal process output limits and TTL. Once a turn
finishes with no live background commands, the worker exits unless negotiated
idle retention keeps it ready for a follow-up. See [node session hosting](/nodes/session-hosting)
for idle limits and eviction. Moving or retiring
the environment, replacing its ownership, or stopping the node also stops its
processes. Process handles do not survive a worker or node restart.

If the node's pairing is revoked or its provider no longer recognizes the lease,
the session placement fails. Physical cleanup can remain pending until OpenClaw
confirms that the exact worker has stopped; an unconfirmed stop does not release
its ownership record.

Worker completion does not currently wake the Gateway session automatically;
use `process poll` in a later turn to inspect the result. Closing a portal closes
its proxy, not the development server: stop the server with `process kill`.

## Control UI

The chat side panel offers a separate **Processes** tab through its **+** menu
and the chat header's **Panels** menu. **Subagents** remains its own tab.
Processes shows the current conversation's background exec commands and retained
finished records, including status, duration, exit information, and recent output.
Reading the output does not drain pending agent output or acknowledge completion
notifications. **Stop** requests termination of the exact observed process instance.

The list is bounded, prioritizes running processes, and follows the existing
in-memory retention limits. It refreshes while visible. A connected node returns
an empty list after confirming that the worker has fully retired and no launch
is still active for that environment. Disconnected workers and uncertain cleanup show
an error. It does not provide an interactive terminal or enumerate unrelated
operating-system processes.

## Child process bridging

After a host exec command finishes, OpenClaw releases its retained process
scope before reporting completion. Children left behind by shell backgrounding
(`&`) are stopped with that scope. To continue ordinary work across turns, let the
long-running command yield a handle with `yieldMs` and use `process` to collect its
result. Request Stop still cancels it on the Gateway or in its sandbox. Reserve
`background: true` for a deliberately independent service. Each command's process
scope stays owned until it finishes; sandbox runtime lifetimes remain with the
sandbox backend.

When spawning long-running child processes outside the exec/process tools (CLI respawns, gateway helpers), attach the child-process bridge helper so termination signals forward and listeners detach on exit/close. This avoids orphaned processes on systemd and keeps shutdown consistent across platforms.

For retained Linux process-group cleanup, adopted zombies are reaped after the
tracked root exits. Active groups share asynchronous direct-child discovery,
woken by child-exit signals with a one-second fallback while descendants remain.
Cleanup stops when the groups disappear or their cleanup budgets expire; it does
not periodically scan the host's process table.

On Linux with the default Node runtime, the Gateway starts a small spawn broker
before loading its main runtime.
If initial broker startup fails, the Gateway logs the failure reason and runtime
entry path, then uses in-process spawning for the rest of that Gateway process.
A new Gateway process tries the broker again.
When the broker is ready, exec commands, shell-snapshot capture and validation,
and helpers using the shared command runner spawn from it, so Linux does not copy
the Gateway's page tables for each command. The existing process supervisors and
service relays still own cancellation, output, and cleanup. After the broker first
becomes ready, broker loss fails affected commands rather than rerunning them; later commands use the restarted
broker. One-shot CLI commands, native file-descriptor inputs, and independently
launched applications keep their local process transport, as do Bun, macOS, and Windows.
The broker has its own process group, which the Gateway terminates on broker loss;
service relays also retain their own parent-loss cleanup.
Broker cleanup grace periods use elapsed time and are unaffected by system-clock corrections.
A detached child can survive a broker crash before its PID is reported, matching
the existing residual for directly spawned children when the Gateway crashes.

Readers of stored credentials also use the broker. If it confirms that a reader
never started, the read falls back once to a local process with the original
environment and working directory. Cancellation, timeouts, uncertain launches, and
cleanup failures do not trigger a retry. Snapshot-backed credential readers keep
their local process transport.

A supervised command's timeout also covers startup, including blocked private-input
delivery. The timeout result can return while cleanup continues. Scope retirement
and Gateway shutdown wait for the cleanup owner separately; when that owner reports
uncertainty, they report failure instead of treating the timeout as proof that the
command has stopped.

Managed exec on Linux with Node or Bun uses a dedicated
child subreaper. It acquires kernel child ownership before launch, adopts orphaned
descendants, and stops and reaps them even if they create another process group
or session. Negotiated worker workspace commands use the same owner through their
Node host. Completion requires the kernel to report no remaining children, the
matching owner receipt, and output drain. It does not depend on group-directed
signals, a process-table census, or inherited-pipe closure alone.

Portable workers use the native helper supplied by their admitted Node host; the
portable archive does not acquire native dependencies. Use matching current host
and worker builds in environments that prohibit process-group signaling. An
unsupported ownership contract fails before launch instead of downgrading to
transport-only cleanup. A source loader with an independent child reaper cannot
share this ownership; source installations using one must build their process helpers.
Process helpers discard inherited instrumentation hooks (`--import`, `--require`,
`-r`, `--loader`, and `--experimental-loader`) from `NODE_OPTIONS`, while retaining
other options such as `--max-old-space-size`. The Gateway and executed commands
keep their instrumentation environment. An explicit source loader needed to run
an unbuilt helper still prevents it from claiming Linux child ownership.
Admission uses the runtime's standalone identity and startup hooks, including
`--import`, `--require`, and loader flags in argv or `NODE_OPTIONS`. A TypeScript
filename alone does not require a source loader: native TypeScript execution and
compiled helpers can retain their source filenames without installing one.

The node journal records Linux descendant extinction separately from older
lineage receipts. A surviving owner can publish that fact after its host stops.
After restart, a missing certificate or uncertain owner identity retains the
physical reservation; restarting is not proof that old descendants stopped.
Older builds do not reinterpret the new certificate as lineage completion.

macOS and retained Bun process-group owners still require kernel group
disappearance. Permission-denied checks never prove absence. A completed command
or closed output pipe alone does not establish that its descendants stopped.
Local TUI shell shutdown uses the same cleanup owner for its own commands.
If the host was busy, cleanup processes queued native completion events before
reporting a timeout.

One-shot tool cleanup keeps configured sandbox runtimes on their
[session, agent, or shared lifetime](/gateway/sandboxing#modes-scope-and-backend). It joins the local
command transport and backend cleanup for that command. It does not stop a shared
sandbox or claim that every remote descendant has exited. Host commands, including
elevated commands from sandboxed sessions, still require owned process-tree cleanup.

When a host command requires process-tree cleanup, a `pty` request falls back to
the child-process path before starting a native PTY and reports a warning. Commands
that require a terminal may fail under that fallback. Cleanup failures remain
uncertain rather than being reported as a clean shutdown.

## process tool

Actions:

| Action      | Effect                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `list`      | Running + finished sessions.                                                  |
| `poll`      | Drain new output for a session (also reports exit status).                    |
| `log`       | Read aggregated output and input-recovery hints. Supports `offset` + `limit`. |
| `write`     | Send stdin (`data`, optional `eof`).                                          |
| `send-keys` | Send explicit key tokens or bytes to a PTY-backed session.                    |
| `submit`    | Send Enter/carriage return to a PTY-backed session.                           |
| `paste`     | Send literal text, optionally wrapped in bracketed paste mode.                |
| `kill`      | Request termination, or return retained terminal facts if already finished.   |
| `clear`     | Remove a finished retained session, including its durable record and log.     |
| `remove`    | Kill if running, otherwise clear if finished.                                 |

Notes:

- Only backgrounded sessions are listed. Ordinary records stay in memory and are lost on process restart; durable records are adopted from SQLite. New handles include an opaque boot suffix so old handles cannot select a different process after restart. A durable process keeps its original handle when adopted. Looking up a lost ordinary handle advises checking saved output and side effects before rerunning. Older handles without a boot suffix cannot distinguish restart from expiry or removal.
- Graceful Gateway shutdown stops ordinary supervised process trees and waits for their cleanup; durable units keep running under the systemd user manager. If earlier Gateway cleanup fails, the spawn broker remains available while command results, output, and process-tree cleanup settle. The shutdown caller still obeys its existing deadline and reports incomplete cleanup. After an abrupt crash, ordinary service-managed child processes have parent-loss cleanup; raw detached processes and native PTY descendants may survive. A lost handle does not establish that the process stopped.
- Resetting or deleting a session clears only its completed background processes; other sessions, explicit shared scopes, and running processes remain unaffected.
- A live ordinary background session blocks cooperative host suspension and safe Gateway restart until the process owner confirms its actual exit. Durable units do not block either operation.
- `process remove` can hide a running session immediately after requesting termination; ordinary processes keep suspension and restart blocked until exit confirmation.
- Process output enters chat history only when a `process poll`/`log` result is recorded. Durable commands also retain their local log artifact until the process record is retired.
- `process` sees its own session’s processes and processes started by ancestor sessions belonging to the same agent. It cannot access sibling sessions, unrelated session trees, or another agent’s processes. Visibility follows the recorded session tree; handles do not need to be copied.
- After an explicit `kill` or task cancellation, `list`, `poll`, `log`, and a repeated `kill` report a confirmed requested stop as a completed observation, retaining the process's signal and cancellation reason. Unexpected termination, timeouts, and cleanup failures remain errors; `finalizationFailed: true` identifies cleanup failure.
- A repeated `kill` of a retained finished session returns its terminal facts without sending another signal or consuming output. An unknown or cleared session ID does not confirm termination.
- Process context shown at turn start is a snapshot. Later `process` results supersede it; the snapshot is not refreshed during the turn.
- Use `poll`/`log` for status, logs, or completion confirmation when automatic completion wake is unavailable.
- Use `log` before recovering an interactive CLI, so the current transcript, stdin state, and input-wait hint are visible together.
- Use `write`/`send-keys`/`submit`/`paste`/`kill` when you need input or intervention.
- `process list` includes a derived `name` (command verb + target) for quick scans.
- `process list`, `poll`, and `log` report `waitingForInput` only when the session still has writable stdin and has been idle longer than the input-wait threshold (default 15000 ms, `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`).
- `process log` uses line-based `offset`/`limit`. When both are omitted, it returns the last 200 lines with a paging hint. When `offset` is set and `limit` isn't, it returns from `offset` to the end (not capped to 200).
- `process poll` and `process log` distinguish output discarded at the aggregate retention cap from output merely omitted by the pending buffer or retained tail. Paged logs can inspect only the retained portion; a durable command's separate local log artifact can still contain earlier output.
- `poll`'s `timeout` waits up to that many milliseconds before returning; values above 30000 are clamped to 30000. The wait ends as soon as the process owner records new output or completion.
- Polling is for on-demand status, not wait-loop scheduling. If the work should happen later, use cron.

Conversational requests can stop an authorized process or remove its retained status by its exact ID without another confirmation. The process owner checks the current record and scope immediately before acting. A stop request does not confirm termination; inspect the resulting process state before reporting it stopped.

Refusal applies to the individual operation. Every later action still requires its
own current authorization and policy checks, including actions from the same
request. Runtime observations describe recorded operation outcomes; they do not
guarantee that all assistant narration is consistent with those outcomes.

Stopping a process reports that termination was requested; use a later poll to
confirm exit and cleanup. Work already admitted follows its own lifecycle.

In [Code Mode](/tools/code-mode), `process` returns its structured details directly.
For `action: "log"`, `output` contains the requested log page, including paging,
retention, and input-recovery hints. Invalid actions and unknown session IDs include
an `error` message alongside `status: "failed"`. Terminal process failures retain
their exit facts, including `finalizationFailed: true` when cleanup failed.

## Examples

Run a task longer than the default 10000 ms yield window and poll later:

```json
{ "tool": "exec", "command": "sleep 30 && echo done" }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Inspect an interactive session before sending input:

```json
{ "tool": "process", "action": "log", "sessionId": "<id>" }
```

Yield an ordinary build after one second:

```json
{ "tool": "exec", "command": "npm run build", "yieldMs": 1000 }
```

Send stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```

Send PTY keys:

```json
{ "tool": "process", "action": "send-keys", "sessionId": "<id>", "keys": ["C-c"] }
```

Submit current line:

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste literal text:

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## Related

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
