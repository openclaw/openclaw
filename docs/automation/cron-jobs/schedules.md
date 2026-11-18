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

The Control UI's **Run at** field uses your browser's local timezone. A time skipped by a daylight-saving transition is invalid; choose a time before or after the gap. A newly entered repeated fall-back time uses its first occurrence. Editing other fields preserves the existing one-shot instant, including its original offset and timestamp precision.

Recurring top-of-hour expressions (minute `0` with a wildcard hour field) are automatically staggered by up to 5 minutes to reduce load spikes. Use `--exact` to force precise timing, or `--stagger 30s` for an explicit window (cron schedules only).

In the Control UI, enable **Exact timing** to disable staggering. For recurring top-of-hour expressions, turn it off and clear **Stagger window** to restore the default window of up to 5 minutes. For other expressions, clearing a saved window without changing the expression disables staggering and reopens with **Exact timing** enabled. A new schedule with a blank window keeps default timing when its expression changes.

An `on-exit` job disables itself when its payload is queued to run. Re-enable the job to watch again; this also works while the previous payload is still finishing. If the new command exits before that payload finishes, its exit waits for the previous run to settle before disabling the job and starting the next payload. This includes cleanup still running after a timeout response. Disabling or changing the watch cancels its pending exit. You can change the watched command or working directory when re-enabling it.

The Gateway owns the watched command's process tree, including cleanup after failed startup. Cleanup must finish before its payload fires or a replacement command starts. If cleanup cannot be confirmed, the Gateway reports the failure, keeps a suspension blocker, and refuses to rearm that watch in the same process. Inspect and stop any remaining command processes, then restart the Gateway; disabling and re-enabling the job does not clear uncertain cleanup.

Changing an `at` or `on-exit` job to an `every` or `cron` schedule clears its inherited `deleteAfterRun` setting. An explicit `deleteAfterRun` value in the same update takes precedence.

### Heartbeat task migration

Run `openclaw doctor --fix` to convert supported heartbeat configuration,
system-owned monitor jobs, and structured scratch tasks into ordinary editable
`agentTurn` jobs. Doctor supports July 2026 and later heartbeat shapes. See
[Heartbeat migration](/gateway/heartbeat) for the migration and older-version guidance.

Conversions preserve job IDs and history, scratch revisions, disabled state,
schedule anchors and pending occurrences, and tool authority. Doctor retires
legacy configuration or scratch task blocks only after verifying the destination.
If an import is ambiguous or incomplete, it keeps the source and reports what
needs attention rather than starting a partially migrated job.

The job becomes authoritative after migration. Use `openclaw automations list`,
`get`, `edit`, and `remove`, or the `automations` agent tool, to manage it. Config
reloads, restarts, and subsequent Doctor runs do not overwrite edits or recreate
a deleted migrated monitor. Runtime does not interpret scratch `tasks:` blocks
as schedules or read `HEARTBEAT.md`.

### Monitoring policies

Use job-level policies for periodic checks that should respect quiet hours and
agent-wide activity. They apply through ordinary scheduler and session admission;
no separate heartbeat runner is involved.

| Field                                    | Behavior                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `activeHours: { start, end, timezone? }` | Restricts execution to a timezone-aware window. Start is inclusive; end is exclusive. Overnight windows are supported. |
| `idleOnly: true`                         | Waits for agent-wide quiet, including other cron jobs and foreground sessions, without occupying a running slot.       |
| `payload.skipIfScratchEmpty: true`       | Skips an agent turn with explicitly empty scratch. Missing scratch still runs.                                         |

`idleOnly: true` checks the whole agent, not just the target session. On busy
shared agents, continuations may defer indefinitely. Set `idleOnly: false` or
leave it unset to use normal admission.

Omitting these fields keeps ordinary automation defaults. A manual force-run
bypasses cadence, but still respects active hours, authorization, lifecycle, and
delivery restrictions. Starting foreground work does not replay side effects
from an already-started run.

`activeHours.start` and `end` use `HH:MM`; only `end` accepts `24:00`.
Equal start and end define an empty window. `timezone` accepts `user` (the
default, using the configured user timezone), `local` (Gateway host), or an IANA
timezone. The window uses local wall-clock time across daylight saving changes,
independently of the cron expression's schedule timezone.

A one-shot `at` job due outside its active hours stays pending until the window
opens. Recurring `every` and `cron` schedules skip that occurrence and advance
to the next scheduled time.

```bash
openclaw automations add \
  --name "Project monitor" \
  --every 30m \
  --session isolated \
  --message "Check the job scratch for newly blocked work. Report changes that need attention; otherwise reply NO_REPLY." \
  --active-hours-start 08:00 \
  --active-hours-end 22:00 \
  --active-hours-timezone user \
  --idle-only \
  --skip-if-scratch-empty \
  --no-deliver
```

The same flags work with `automations edit`. Supply both window endpoints when
adding a window; edits can change one field of an existing window. Use
`--clear-active-hours` to remove the window, `--no-idle-only` to turn off the
idle-only policy, or `--clear-idle-only` to remove that stored policy.

Keep instructions explicit: name the sources or checklist, do not infer old
tasks from past chats, and report changes that need attention. A human check-in
is a separate job with an intentional cadence. See
[Job scratch and quiet results](/automation/cron-jobs/payloads#job-scratch-and-quiet-results)
and [Owner delivery](/automation/cron-jobs/delivery#owner-delivery-and-direct-messages).

### Stream sources

A stream schedule keeps an operator-authored argv command running under the Gateway and fires the job from its stdout and stderr lines. Stream schedules are event-driven, never time-due, and are available by default.

The agent-facing `automations` tool requires the creator turn to expose `exec` for the stream’s execution location. With `ask: "always"`, creating a stream asks the user to approve that specific persistent watcher. The question identifies the command and execution location, describes output behavior and delivery, and explains that the watcher continues after the conversation and automatically restarts after interruptions and Gateway restarts until disabled or deleted. Approval authorizes that saved watcher, not other commands or additional watchers. Time spent awaiting approval does not require another approval for the same proposal.

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

Set `cron.triggers.enabled: false` to disable streams together with model-free checks. Disabling or removing the job stops the process; Gateway shutdown waits for process-tree teardown. Fast failures restart with the scheduler's built-in error backoff. Five consecutive runs shorter than 60 seconds leave the job in an error state and use the normal failure-alert path; manually re-enable the job to clear the restart cap.

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

When a stream job has a check, it evaluates once per batch. Read the batch as `check.streamBatch`. A quiet check consumes the batch; a wake also appends the batch to the agent prompt.

### Dynamic cadence (pacing)

Recurring jobs can set `pacing.min` and/or `pacing.max` to duration strings such as `15m` or `4h`; at least one bound is required. Use `--pacing-min` and `--pacing-max` with `automations add|edit` (`--clear-pacing` removes both bounds).

The Control UI preserves pacing bounds when duplicating a recurring job. Changing a paced job or its duplicate to **Once** removes pacing; other edits retain the existing bounds.

During an agent-turn run, a paced job can call the `automations` tool with `action: "next_check"` and `in: "30m"`. The proposal applies only to that currently running job and is measured from successful run completion. OpenClaw silently clamps it to the configured bounds. A future paced deadline remains the next scheduled check after a Gateway restart.

Pacing without a proposal leaves the normal schedule unchanged. Failed, timed-out, and skipped runs discard any new proposal. A failed paced check retains its pending occurrence and retries with the existing error backoff, including after a Gateway restart; it does not fall back to the normal schedule until a check succeeds or the job is disabled. Manually forcing a recurring job is out-of-band and preserves its pending natural or paced slot. For condition-triggered jobs, the built-in minimum interval remains a lower bound even when a proposal requests an earlier check.

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

<a id="event-triggers-condition-watchers" />

## Model-free checks

A check runs JavaScript on the automation's schedule without calling a model. Return one outcome:

| Result                       | What happens                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| `{ state }` (or `{}`)        | Stay quiet.                                                          |
| `{ post: "message", state }` | Send the message through the job's configured delivery.              |
| `{ wake: "message", state }` | Append the message to the configured agent prompt and run that turn. |

The previous JSON state is frozen as `check.state`. Omit `state` to keep it or return `state: null` to clear it. State is limited to 16 KB and only committed on success. A check can also return a `nextCheck` duration on a job with pacing bounds. `once: true` disables the job after its first successful post or wake; quiet checks don't count.

For example, save this as `check-workspace.js`:

```js
const lastStatus = check.state?.status;
const status = "degraded";
const state = { status };
return status === lastStatus ? { state } : { post: "Workspace needs attention", state };
```

```sh
openclaw automations add --name "Workspace health" --every 5m --check-script ./check-workspace.js
```

Add `--message` to configure an agent prompt for `wake`. Checks with a prompt use a recurring interval, cron, or stream schedule; interval checks with a prompt must be at least 30 seconds apart. A forced manual run runs the prompt directly when there is one. Use `--due` or wait for the next scheduled occurrence to test the check itself. A check-only job always evaluates its script, including on a forced run.

Checks use Code Mode under the job's tool policy. They default to 30 seconds and five tool calls; set `--check-timeout-seconds` or `--check-tool-budget` to override. MCP is available only for servers explicitly named by a `toolsAllow` entry like `<server>__<tool>` or `<server>__*`. A bare `*` does not expose MCP servers. Set `cron.triggers.enabled: false` to disable checks deployment-wide. Shell command payloads keep their separate operator policy.

After a direct upgrade, run `openclaw doctor --fix`. Doctor backs up cron storage, converts supported condition scripts and JavaScript payloads, and reports each result. It preserves schedule, saved state, once settings, tool access and budgets on converted jobs. It pauses jobs whose behavior it cannot safely translate (such as conversation-event wakes or conditions that start a shell command), without deleting the job. Review the original definition in the backup, edit the check, and re-enable it when ready.
