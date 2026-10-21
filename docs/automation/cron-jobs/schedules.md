---
doc-schema-version: 1
summary: "Schedule kinds, cron expressions, stream sources, pacing, and condition triggers"
read_when:
  - Choosing between at, every, cron, on-exit, and stream schedules
  - Writing a cron expression or a timezone-aware schedule
  - Adding a condition script that gates when a job fires
title: "Automation schedules"
sidebarTitle: "Schedules"
---

When a job fires: the five schedule kinds, cron expression rules, dynamic cadence, and condition watchers. Part of the [Automations](/automation/cron-jobs) guide.

## Schedule types

| Kind      | CLI flag           | Description                                                                                              |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `at`      | `--at`             | One-shot timestamp (ISO 8601 or relative like `20m`)                                                     |
| `every`   | `--every`          | Fixed interval (`10m`, `1h`, `1d`)                                                                       |
| `cron`    | `--cron`           | 5-field or 6-field cron expression with optional `--tz`                                                  |
| `on-exit` | `--on-exit`        | Fire once when a watched command exits (event trigger; survives turn teardown; optional `--on-exit-cwd`) |
| `stream`  | `--stream-command` | Fire from batched lines produced by a supervised long-lived command                                      |

These schedule flags work with both `openclaw automations add` and `openclaw automations edit <job-id>`. For example, `openclaw automations edit <job-id> --on-exit "./watch.sh" --on-exit-cwd /srv/app` converts an existing job to an exit-triggered schedule.

Timestamps without a timezone are treated as UTC. Add `--tz America/New_York` to interpret an offset-less `--at` datetime, or to evaluate a cron expression, in that IANA timezone. Cron expressions without `--tz` use the Gateway host timezone. `--tz` is not valid with `--every` or `--on-exit`.

Recurring top-of-hour expressions (minute `0` with a wildcard hour field) are automatically staggered by up to 5 minutes to reduce load spikes. Use `--exact` to force precise timing, or `--stagger 30s` for an explicit window (cron schedules only).

In the Control UI, enable **Exact timing** to disable staggering. For recurring top-of-hour expressions, turn it off and clear **Stagger window** to restore the default window of up to 5 minutes. For other expressions, clearing a saved window without changing the expression disables staggering and reopens with **Exact timing** enabled. A new schedule with a blank window keeps default timing when its expression changes.

An `on-exit` job disables itself when its payload is queued to run. Re-enable the job to watch again; this also works while the previous payload is still finishing. If the new command exits before that payload finishes, its exit waits for the previous run to settle before disabling the job and starting the next payload. This includes cleanup still running after a timeout response. Disabling or changing the watch cancels its pending exit. You can change the watched command or working directory when re-enabling it.

The Gateway owns the watched command's process tree, including cleanup after failed startup. Cleanup must finish before its payload fires or a replacement command starts. If cleanup cannot be confirmed, the Gateway reports the failure, keeps a suspension blocker, and refuses to rearm that watch in the same process. Inspect and stop any remaining command processes, then restart the Gateway; disabling and re-enabling the job does not clear uncertain cleanup.

Changing an `at` or `on-exit` job to an `every` or `cron` schedule clears its inherited `deleteAfterRun` setting. An explicit `deleteAfterRun` value in the same update takes precedence.

### Heartbeat task migration

Heartbeat scratch supported a structured `tasks:` block before v2026.8.1. If you are upgrading from an earlier release, run `openclaw doctor --fix` to convert each entry into an ordinary editable main-session automation job. Doctor preserves the interval and previous last-run timing, creates the jobs before removing the block, and safely converges the same declaration keys on rerun.

These migrated jobs carry public `systemEvent` payloads, so `openclaw automations list`, `get`, `edit`, and `remove` plus the `automations` agent tool manage them like other jobs (the tool still accepts its legacy `cron` name as a compatibility alias). Their execution uses the guarded heartbeat task wake: active hours, minimum spacing, flood control, and retries while the target session is busy still apply, while the scheduler owns each task's independent cadence. Jobs due in the same coalescing window can share one heartbeat turn. A scheduled occurrence outside heartbeat active hours is skipped and retried at the job's next occurrence.

Heartbeat scratch is monitor prose only. Runtime heartbeats do not parse `tasks:` text as schedules; create new recurring work as automations.

### Stream sources

A stream schedule keeps an operator-authored argv command running under the Gateway and fires the job from its stdout and stderr lines. Stream schedules are event-driven, never time-due, and are available by default.

The agent-facing `automations` tool requires the creator turn to expose `exec` for the stream’s execution location. With `ask: "always"`, creating a stream asks the user to approve that specific persistent watcher. The question identifies the command and execution location, describes output behavior and delivery, and explains that the watcher continues after the conversation and automatically restarts after interruptions and Gateway restarts until disabled or deleted. Approval authorizes that saved watcher, not other commands or additional watchers.

```json
{
  "tools": {
    "exec": {
      "host": "gateway",
      "security": "allowlist",
      "ask": "always"
    }
  }
}
```

Source changes (`command`, `cwd`, matching, or batching), setting `enabled: true`, and clearing restart exhaustion require fresh approval when exec asks. Disabling or deleting a watcher, equivalent schedule resaves, and unrelated payload or delivery edits do not ask for execution approval. Account-owned streams remain manageable by their creator; operator-created streams retain operator management.

When exec asks, the Gateway saves no runnable job without affirmative approval. Denial, expiry, cancellation, or unavailable approval delivery leaves the job unchanged, regardless of `askFallback`. A declined, expired, or canceled approval request is closed and cannot later be approved; ask the agent for a new proposal if you want another attempt under the existing permissions and approval settings. It rechecks current policy and the exact proposal when saving: newly required approval opens a question, a changed proposal or policy requires a fresh decision, and `security: "deny"` still refuses execution. Sandbox exec authorizes a stream in a dedicated container under that sandbox's policy; it cannot authorize a Gateway stream. Node-only exec cannot create streams. Full unattended Gateway exec remains available without a question; explicit full-permission sessions retain their existing host-policy exemption. Changing the approval setting alone does not prompt again for an already approved watcher.

A successful `automations` add or update includes `streamExecutionApproval` when that save consumed a native user approval. It reports the `approvalId`, `decision: "allow-once"`, `source: "operator"`, and a human-readable approval message. This confirms the question was already approved, even when the reply is not visible in chat. The field is absent for unattended saves and unchanged declarations; it does not grant permission to future agent actions or report whether the watcher is still running.

When a native approval ends without permission, `automations` returns `saved: false` with an `outcome` of `operator-denied`, `expired`, or `cancelled`. This is a terminal outcome for that proposal, not invalid parameters. A refused update leaves the existing watcher unchanged. The refusal applies to that proposal. Later actions, including actions from the same request, must independently satisfy their current permissions and approval settings. Automations saved earlier continue under their configured lifecycle. A generic operator receipt does not establish that the current viewer approved it.

In Control UI, a stream proposal shows **Start watching** or **Save watcher change** alongside **Cancel**. Reopening the conversation restores pending approvals.

For current saved watcher state, ask the agent to inspect the known job with `automations get`. The result includes `enabled` and `state.streamStatus`. Assistant prose, an earlier observation, and the `enabled` flag alone do not confirm source termination.

Watcher tool results distinguish the saved configuration from the runtime's observed state, such as starting, running, stopped, or error. A disabled watcher whose stop is unconfirmed means automatic restart is disabled; it does not mean the source has exited. Chat history preserves the observation made for that operation, not a fresh status check or permission grant. Removing a saved record alone also does not prove physical termination.

To stop a saved watcher, ask the agent to disable it with `update` and `job: { enabled: false }`, or open it on the **Automations** page and turn off its **Active** switch. The switch then shows **Paused**; the saved record remains. Disabling a watcher does not stop separate ordinary background processes. Those require their own process IDs and confirmed cleanup.

Conversational requests can disable or delete an authorized automation by its exact ID without another confirmation. The owner checks its captured configuration revision before applying the change; a changed definition requires a fresh inspection. If the intended target is unclear, the agent should clarify it before acting. The Automations switch remains a single action. Required execution approval for creating or restarting a watcher is unchanged.

Approval covers the saved command and paths for the watcher's lifetime. Gateway streams check executable, script, and working-directory identity across the approval wait. Sandbox streams recheck the configured image and sandbox policy across that wait; guest paths resolve in the image and approved mounts. Approval does not permanently freeze image tags or files at those paths. Each sandbox start resolves the operator-configured image and pins its immutable Docker image ID for that attempt.

#### Sandboxed streams

An agent using a supported local Docker sandbox can create a stream in a dedicated container. Every start and restart creates a fresh container from the configured image, with the same approved workspace, mounts, user, filesystem access, and network restrictions. The configured `setupCommand` runs for each fresh container. Commands and working directories refer to guest paths. There is no host fallback.

The stream does not share the agent container's existing writable layer, temporary files, sockets, or running services. Install dependencies in the image or `setupCommand`, or keep them in approved mounted paths. Mounted workspace data persists; changes elsewhere in a stream container disappear when that attempt ends.

Each stream container receives the configured resource limits separately. Additional streams therefore add containers and can increase total memory, CPU, process, and disk use; they do not share one resource budget with the agent container.

Sandbox tool policy excludes `automations` by default. Enable it explicitly alongside `exec`; an existing explicit deny still takes precedence:

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session", workspaceAccess: "ro" },
    },
  },
  tools: {
    allow: ["exec", "automations"],
    exec: { host: "sandbox", ask: "always" },
    sandbox: { tools: { alsoAllow: ["automations"] } },
  },
}
```

This support requires a supported local Docker Unix socket. Other sandbox backends and remote Docker endpoints retain ordinary exec support but cannot create persistent streams. The approval question identifies the dedicated Docker container behavior and explains the long-running command and automatic restarts.

OpenClaw checks current session, operator, exec, and sandbox authority before each start and while the stream is active. A revoked grant, removed session, explicit exec denial, or changed sandbox configuration cannot inherit the old approval. Active streams prevent idle pruning. Explicit sandbox removal or recreation removes the associated stream containers and settles workspace changes before retiring their workspace owner.

A stream can continue running after a controller crash or lost connection until OpenClaw recovers and cleans it up. There is no autonomous execution lease inside the container. Recovery removes the exact recorded stream container through its original Docker daemon and confirms its absence before settling the workspace, deleting cleanup records, or starting a replacement. An unreachable or changed Docker daemon blocks replacement; restore access to the original daemon so cleanup can finish.

After a Linux or macOS host reboot, recovery requires the same recorded machine identity before reclaiming a previous controller's cleanup work. Missing, changed, or unreadable machine identity keeps cleanup blocked; a hostname alone cannot establish that the previous controller is gone. OpenClaw retains only an application-specific hash of the OS machine identifier.

Before downgrading, stop and settle sandbox streams on the current version. Older versions quarantine these jobs instead of running them on the Gateway. After upgrading again, explicitly restore or recreate them under current policy and approval; they do not resume automatically from quarantine.

Set `cron.triggers.enabled: false` to disable streams together with condition-trigger scripts and script payloads. Disabling or removing the job stops the process; Gateway shutdown waits for process-tree teardown. Fast failures restart with the scheduler's built-in error backoff. Five consecutive runs shorter than 60 seconds leave the job in an error state and use the normal failure-alert path; manually re-enable the job to clear the restart cap.

```bash
openclaw automations add \
  --name "Build event stream" \
  --stream-command '["node","scripts/build-events.mjs"]' \
  --stream-mode match \
  --stream-match '^(failed|recovered):' \
  --stream-batch-ms 250 \
  --session isolated \
  --message "Investigate these build events."
```

For a simple log condition, use the existing match mode instead of writing a trigger program. Prepare the source with finite inspection, then create the saved watcher directly; a separate ordinary background watcher is unnecessary. For example, the agent tool can receive:

```json
{
  "action": "add",
  "job": {
    "name": "Application errors",
    "schedule": {
      "kind": "stream",
      "command": ["tail", "-n", "0", "-F", "/workspace/application.log"],
      "mode": "match",
      "match": "ERROR"
    },
    "sessionTarget": "current",
    "payload": { "kind": "agentTurn", "message": "Report the matching application errors." }
  }
}
```

`mode: "line"` (the default) accepts every line. `mode: "match"` accepts only lines matching the compiled `match` regex. A batch closes after `batchMs` of quiet (default 250 ms, clamped to 50–5000) or at `maxBatchBytes` (default 16384, clamped to 1024–65536). At the byte cap the batch ends with `[truncated]`. Match mode always evaluates complete lines against their full text, even past `maxBatchBytes` (only the delivered batch is truncated); a line cut at the bounded raw-intake limit is only a prefix, so it is treated as unmatched rather than letting an end-anchored pattern fire on the cut. The batch is appended to the system-event text or agent-turn message. Command payloads are rejected for stream schedules because the source command and payload command would have ambiguous process ownership.

Matching has a bounded processing budget and queue. If either limit is exceeded, the source stops with a recorded error; check the match expression and Gateway load, then manually re-enable the job.

Only one payload fire and one bounded pending batch are retained per job. Lines arriving while a payload runs, or before the built-in 30-second trigger interval has elapsed, coalesce into that pending batch rather than building an unbounded queue. One serialized owner records gate drops, payload errors, and not-running dispatches in `streamDroppedBatches`; bounded merges increment `streamCoalescedBatches`. Failed payloads are not retried because repeating them may duplicate their effects. A logical source identity remains stable across supervised child restarts, but rotates when the source is disabled, removed, or replaced, so queued batches from the retired source cannot fire even after an A-to-B-to-A edit. After a stop completes, late callbacks from an old child are inert. There is no native WebSocket source; bridge one with an argv command such as `websocat wss://example.invalid/events`.

Batch deadlines and retries when a job is busy use the Gateway scheduler. After sleep, each elapsed deadline runs once. Stopping a source cancels its pending deadlines and waits for started callbacks to settle.

When a stream job also has `trigger.script`, the gate runs once per closed batch. The current batch is available as the deeply frozen `trigger.streamBatch` string alongside `trigger.state`. `fire: false` drops that batch after persisting gate state. `fire: true` keeps existing trigger message semantics, then appends the batch to the resulting payload. A stream job may instead use a script payload without a condition gate; that script receives the batch through the same `trigger.streamBatch` value. Combining a script payload with a condition gate is rejected because both would own the persisted `trigger.state` slot.

### Dynamic cadence (pacing)

Recurring jobs can set `pacing.min` and/or `pacing.max` to duration strings such as `15m` or `4h`; at least one bound is required. Use `--pacing-min` and `--pacing-max` with `automations add|edit` (`--clear-pacing` removes both bounds).

The Control UI preserves pacing bounds when duplicating a recurring job. Changing a paced job or its duplicate to **Once** removes pacing; other edits retain the existing bounds.

During an agent-turn run, a paced job can call the `automations` tool with `action: "next_check"` and `in: "30m"`. The proposal applies only to that currently running job and is measured from successful run completion. OpenClaw silently clamps it to the configured bounds. A future paced deadline remains the next scheduled check after a Gateway restart.

Pacing without a proposal leaves the normal schedule unchanged. Failed, timed-out, and skipped runs discard the proposal, so existing retry and error-backoff behavior takes precedence. Manually forcing a recurring job is out-of-band and preserves its pending natural or paced slot. For condition-triggered jobs, the built-in minimum interval remains a lower bound even when a proposal requests an earlier check.

### `/loop` chat shortcut

In chat, the owner-only `/loop [interval] <prompt>` command creates a recurring agent-turn job bound to that conversation. Give an interval such as `5m` for fixed cadence, or omit it to let the loop self-pace between 1 minute and 1 hour with `next_check`. Use `/loop status` to list conversation-bound loops and `/loop stop [name]` to remove them.

### Day-of-month and day-of-week use OR logic

Cron expressions are parsed by [croner](https://github.com/Hexagon/croner). When both the day-of-month and day-of-week fields are non-wildcard, croner matches when **either** field matches, not both. This is standard Vixie cron behavior.

```bash
# Intended: "9 AM on the 15th, only if it's a Monday"
# Actual:   "9 AM on every 15th, AND 9 AM on every Monday"
0 9 15 * 1
```

This fires roughly 5-6 times a month instead of 0-1 times a month. To require both conditions, use croner's `+` day-of-week modifier (`0 9 15 * +1`), or schedule on one field and guard the other in your job's prompt or command.

## Event triggers (condition watchers)

An event trigger adds a headless condition script to an `every`, `cron`, or `stream` schedule. Time schedules evaluate it when due; stream schedules evaluate it for each closed batch. The scheduler runs the normal payload only when the script returns `fire: true`:

```json5
{
  schedule: { kind: "every", everyMs: 30000 },
  trigger: {
    // Fires only when the observed status differs from the last evaluation.
    script: "const res = await exec({ command: 'gh pr checks 123 --json state -q \\'.[].state\\' | sort -u' }); const status = String(res?.aggregated ?? '').trim(); json({ fire: status !== trigger.state?.status, message: `PR 123 CI: ${trigger.state?.status ?? 'unknown'} -> ${status}`, state: { status } });",
    once: false,
  },
  payload: { kind: "agentTurn", message: "Investigate the CI status change." },
}
```

Forced manual runs bypass this gate: `openclaw automations run <job-id>` (forced by default) and the `automations` tool with `action: "run", runMode: "force"` skip `trigger.script` and execute the payload directly. An `agentTurn` payload wakes the model even if the script would return `fire: false`. To test the gate, wait for a scheduled evaluation or use `openclaw automations run <job-id> --due` when the job is due. The tool's default `runMode: "due"` also honors the gate; neither due mode makes a job due early.

`openclaw doctor --fix` converts persisted trigger scripts that call `tools.call('exec', args)` and read the `.result.details` envelope. Doctor leaves custom or ambiguous scripts unchanged and identifies each affected job for manual conversion; standalone script payloads are not converted.

The script must return `{ fire, message?, state? }`. The previous JSON state is available as the deeply frozen `trigger.state`; stream gates also receive the current batch as `trigger.streamBatch`. Return a new `state` value to persist it. State is capped at 16 KB. When a firing result includes `message`, the scheduler appends it to the system-event text or agent-turn message before execution. `once: true` disables the job after its first successful fired payload.

Changing a running watcher's condition or saved state protects that edit from the
old evaluation's state updates and `once` completion, including after a Gateway
restart. The completed payload still retains its run history. An unchanged
watcher keeps its usual `once` behavior; renaming it does not reset its condition.

`fire: false` persists evaluation state and counters, then reschedules without creating run history. These quiet evaluations count as completed occurrences during restart catch-up. If a fired payload run fails, the returned `state` is **not** persisted — the next evaluation sees the previous state and can fire again, so write scripts as read-only checks and keep actions in the payload. Trigger schedules have a built-in minimum interval of 30 seconds, preserved through maintenance and Gateway restarts. Each evaluation has a 30-second wall-clock budget and up to 5 tool calls.

Scripts call configured MCP server tools through the same `MCP.<server>.<tool>({ ...input })` namespace that interactive Code Mode uses. MCP is opt-in per server: a script can reach only the servers its job's `toolsAllow` (`--tools`) names with a server prefix, either an exact tool such as `wispr-flow__search_meetings` or a server-scoped glob such as `wispr-flow__*`. A wildcard `*`, a missing `toolsAllow`, or a glob without a server prefix gives the script no `MCP` namespace and starts no server, because evaluations can run every 30 seconds. A script whose source never mentions `MCP` also starts no server, even when `toolsAllow` names one for the payload. Within a named server, the owning agent's tool policy still applies, as in an interactive run. MCP calls go through the same before-tool-call hooks and approvals and return the same untrusted-content results. Each evaluation starts its own runtime for the named servers only and retires it when the evaluation ends; a slow server shutdown finishes in the background after a 1-second grace. Connecting and listing tools count toward the 30-second budget, and each MCP call counts toward the 5-call limit. A named server that fails to start is absent from `MCP`; if the script then fails, the run error ends with `MCP server "<name>" is unavailable: <reason>`.

Returning `fire: false` from an MCP-backed check skips the payload, and its model call, on quiet ticks:

```js
const { structuredContent } = await MCP.wisprFlow.searchMeetings({
  since: trigger.state?.cursor,
});
const meetings = structuredContent?.meetings ?? [];
if (meetings.length === 0) return { fire: false };
return {
  fire: true,
  message: `${meetings.length} new meetings`,
  state: { cursor: meetings.at(-1).id },
};
```

Removing or disabling a job during condition evaluation cancels that evaluation before its payload can start. After a main-session payload hands work to heartbeat, that shared heartbeat retains its own lifecycle.

Author watchers around **actionable state**, not only success: a watcher that goes quiet when its check fails or times out looks healthy while broken. Compare the observation with `trigger.state` and return fresh state to deduplicate; do not rely on model or process memory. When firing, make `message` self-contained because it becomes the fired run's complete event context.

<Warning>
Condition-trigger scripts and `script` payloads run unattended by default with the owning agent's **full tool policy, including `exec`**. Stream schedules also keep operator-authored commands running unattended. Treat these surfaces as unattended code execution with that agent's permissions. Operators who need a hard stop can set `cron.triggers.enabled: false`; remove it or set it to `true` to re-enable them.
</Warning>

Create a watcher from a local script file (`-` reads the script from stdin). The CLI preserves leading and trailing spaces in file paths; quote the path as one shell argument:

```bash
openclaw automations add \
  --name "PR CI watcher" \
  --every 30s \
  --trigger-script ./watch-pr-ci.js \
  --message "Respond to the CI status change" \
  --session isolated
```
