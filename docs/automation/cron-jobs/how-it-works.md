---
doc-schema-version: 1
summary: "Automation runtime model, run lifecycle, and promoting a repeated job into a schedule"
read_when:
  - Deciding whether automations fit a scheduled workload
  - Debugging run lifecycle, catch-up, or task reconciliation
  - Turning a repeated request into a stored schedule
title: "How automations work"
sidebarTitle: "How they work"
---

How the Gateway scheduler runs a job, what it keeps between runs, and how a repeated request becomes a stored schedule. Part of the [Automations](/automation/cron-jobs) guide.

## How automations work

- Automations run **inside the Gateway process**, not inside the model. The Gateway must be running for schedules to fire.
- Job definitions, runtime state, and run history persist in OpenClaw's shared SQLite state database, so restarts do not lose schedules.
- Automation runs are recorded in cron run history.
- Agent, command, and script jobs write their result once into the chat or topic that receives it, including jobs without a creating conversation. A different delivery destination gets the result instead of the creating chat; without an external route, the creating conversation receives it. Execution context remains separate. See [Automation delivery](/automation/cron-jobs/delivery).
- One-shot jobs (`--at`) auto-delete after successful completion: delivery is confirmed, not requested, intentionally suppressed, or explicitly best-effort. Failed or unknown required delivery retains the job disabled for inspection without replaying the payload. Pass `--keep-after-run` to keep successful jobs too.
- Per-run wall-clock budget: `--timeout-seconds` when set. Otherwise, isolated/detached agent-turn jobs are bounded by the scheduler's own 60-minute watchdog; command jobs default to 10 minutes, and script payloads default to 5 minutes. This scheduler deadline is independent of the per-model-attempt budget (`agents.defaults.timeoutSeconds`, default 48 hours): starting a fallback does not reset it.
- On Gateway startup, overdue agent-turn jobs and jobs that await a heartbeat are rescheduled instead of replayed immediately, keeping model/tool execution out of scheduler startup. This includes heartbeat monitors, migrated heartbeat tasks, and main-session system events with immediate wake. Startup catch-up delays survive label or payload-content reconciliation and another restart; changing the schedule starts a new scheduling decision.
- Jobs whose agents are still preparing remain queued without blocking healthy agents. They resume when their Gateway's preparation finishes.
- Cron slots that pass during a successful or skipped scheduled run are not replayed at restart. Slots missed after that run finishes remain eligible for catch-up. Forced runs still leave their scheduled occurrence pending.
- When a running Gateway wakes after a deadline, the cron worker coalesces missed timer ticks using its stored deadlines and run requests. The worker owns scheduling, queue capacity, and durable results; the Gateway launches committed requests and joins the worker during shutdown.
- If you drive `openclaw agent` from system cron or another external scheduler, wrap it with a hard-kill escalation even though the CLI already handles `SIGTERM`/`SIGINT`. Gateway-backed runs ask the Gateway to abort accepted runs; `--local` runs get the same abort signal. For GNU `timeout`, prefer `timeout -k 60 600 openclaw agent ...` over plain `timeout 600 ...` — the `-k` value is the backstop if the process cannot drain in time. For systemd units, use a `SIGTERM` stop signal with a grace window (`TimeoutStopSec`) before the final kill. Reusing a `--run-id` while the original Gateway run is still active reports the duplicate as in-flight instead of starting a second run.

<AccordionGroup>
  <Accordion title="Isolated run hardening">
    - Scheduled runs have their own execution lifetime from admission through result persistence and cleanup. Timer ticks, startup catch-up, and event-source watchers do not inherit the request state of the conversation that created or updated them. Manual runs retain their caller authority.
    - Isolated runs best-effort close tracked browser tabs/processes for their `cron:<jobId>` session on completion, and dispose any bundled MCP runtime instances created for the job through the same shared teardown path used by main-session and custom-session runs. Cleanup failures are ignored so the run result still wins.
    - A run's continuation session stays available while descendant subagents are running or their completion delivery is pending, including during retention sweeps, so cleanup cannot strand their results.
    - Isolated runs with the narrow automation self-cleanup grant can read scheduler status, a self-filtered list containing only their own job, and that job's run history, and may remove only their own job.
    - Isolated runs guard against stale acknowledgement replies: if the first result is only an interim status update (`on it`, `pulling everything together`, and similar hints) and no descendant subagent is still responsible for the final answer, OpenClaw re-prompts once for the actual result before delivery. Run totals include both completed prompts, priced by their respective models; session context usage still reflects the final model request.
    - Structured execution-denial metadata (including node-host `UNAVAILABLE` wrappers whose nested error starts with `SYSTEM_RUN_DENIED` or `INVALID_REQUEST`) is recognized so a blocked command is not reported as a green run, while ordinary assistant prose is not mistaken for a denial.
    - Run-level agent failures count as job errors even with no reply payload, so model/provider failures increment error counters and trigger failure notifications instead of clearing the job as successful.
    - When a job hits `timeoutSeconds`, the scheduler aborts the run and gives it a short cleanup window. If it does not drain, Gateway-owned cleanup force-clears that run's session ownership before the scheduler records the timeout, so queued chat work is not stuck behind a stale processing session.
    - Setup/startup stalls get a phase-specific timeout (for example `cron: isolated agent setup timed out before runner start` or `cron: isolated agent run stalled before execution start (last phase: context-engine)`). These watchdogs cover embedded and CLI-backed providers even before their external CLI process starts, and are capped independently of long `timeoutSeconds` values so cold-start/auth/context failures surface quickly.

  </Accordion>
  <Accordion title="Run reconciliation">
    <a id="task-reconciliation" />

    Cron owns recovery and history for its own runs; an empty client process is not evidence that a Gateway run has stopped.

    The cron worker records execution and primary-delivery outcomes together with job state and history. Post-run notifications happen afterward; a notification failure cannot undo the recorded result.

    Restart recovery matches a recorded terminal result to the exact run identity and restores it without running the payload or delivery again. Without a recorded terminal result, an active run becomes interrupted with delivery **Unknown**. An enabled, unchanged, time-scheduled agent-turn job interrupted before delivery gets one fresh retry, including one-shot jobs. The retry restores current job authority and asks the agent to reconcile prior work before continuing; arbitrary interrupted tool effects are not guaranteed exactly once. Possible prior delivery, command/script payloads, and event or process-exit schedules are not automatically replayed. Inspect their history and recipient before retrying manually. An early manual run preserves its separate scheduled occurrence even if it waited past that deadline before starting. The interrupted manual run is still failed and is not retried. A separately rescheduled one-shot keeps its new occurrence.

    Queued timed requests can resume after restart. Queued manual or event requests whose transient payload was lost record a skipped outcome instead of reconstructing the payload. Catch-up limits and delays still pace overdue scheduling. A terminal result with `deleteAfterRun` deletes the job only when completion is `succeeded`.

    If a completed run's history was saved but its job update failed, a later acknowledged schedule or pacing edit keeps its next check through recovery. Recovery retains the completed history and settles the old run without executing its payload again. Saving an unchanged schedule does not change how that completed run is recovered.

    Interrupted runs appear as failures in run history. Recovering the same interruption again does not add another history entry.

  </Accordion>
</AccordionGroup>

## Promoting a repeated job into an automation

Most automations should start as work the agent already did. When you ask for
substantially the same job several times, the agent offers to turn it into a
schedule instead of only running it once more. Promotion is preferred over
building a job from scratch because the proposal inherits a run you already
read: you know what the output looks like before it starts arriving on a
schedule.

There is no repetition-detection engine and no new stored history. The agent
recognizes the repeat from the conversation itself and checks
`automations(action: "list")` for an existing job before proposing a new one,
so a routine you already created is not duplicated. The prompting that drives
this is gated on the automations tool, so agents without it never offer a
routine they could not create.

The confirmation restates the schedule and the task in plain words before
anything is created, for example: "Every weekday at 07:00 Europe/Vienna, I
summarize overnight updates and post them here." Confirm that sentence, not a
cron expression.

On confirmation the agent:

1. Creates the job, with delivery defaulting to the conversation where you asked:
   its channel and thread, or a conversation commit when there is no external route.
2. Immediately runs it once with `run` in `force` mode as a visible test,
   delivered to that same conversation, so you see real output well before the first
   scheduled occurrence.
3. Removes the job and tells you if that test fails.

The job is created **enabled**, not disabled-pending-approval, and that is a
deliberate safety choice. The scheduler supervises enabled jobs: a failing one
raises a failure notification and is auto-disabled after repeated errors, with
the reason recorded and the owner notified. Nothing supervises a disabled job.
A job left disabled waiting for a confirmation that never arrives is invisible
to every guard, hidden from the default `automations list`, and will never fire
or explain itself — a silent non-outcome, which is a worse failure than a job
that runs and visibly complains.

Your confirmation still gates creation, so nothing is scheduled behind your
back, and the test run is a real run with real delivery rather than a rendered
preview: what you approve is exactly what the schedule will produce.
