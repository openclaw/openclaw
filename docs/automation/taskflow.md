---
summary: "Task Flow flow orchestration layer above background tasks"
read_when:
  - You want to understand how Task Flow relates to background tasks
  - You encounter Task Flow or openclaw tasks flow in release notes or docs
  - You want to inspect or manage durable flow state
title: "Task Flow"
---

# Task Flow

Task Flow is the flow orchestration substrate that sits above [background tasks](/automation/tasks). It manages durable multi-step flows with their own state, revision tracking, and sync semantics while individual tasks remain the unit of detached work.

## When to use Task Flow

Use Task Flow when work spans multiple sequential or branching steps and you need durable progress tracking across gateway restarts. For single background operations, a plain [task](/automation/tasks) is sufficient.

| Scenario                              | Use                  |
| ------------------------------------- | -------------------- |
| Single background job                 | Plain task           |
| Multi-step pipeline (A then B then C) | Task Flow (managed)  |
| Observe externally created tasks      | Task Flow (mirrored) |
| One-shot reminder                     | Cron job             |

## Sync modes

### Managed mode

Task Flow owns the lifecycle end-to-end. It creates tasks as flow steps, drives them to completion, and advances the flow state automatically.

Example: a weekly report flow that (1) gathers data, (2) generates the report, and (3) delivers it. Task Flow creates each step as a background task, waits for completion, then moves to the next step.

```
Flow: weekly-report
  Step 1: gather-data     → task created → succeeded
  Step 2: generate-report → task created → succeeded
  Step 3: deliver         → task created → running
```

### Mirrored mode

Task Flow observes externally created tasks and keeps flow state in sync without taking ownership of task creation. This is useful when tasks originate from cron jobs, CLI commands, or other sources and you want a unified view of their progress as a flow.

Example: three independent cron jobs that together form a "morning ops" routine. A mirrored flow tracks their collective progress without controlling when or how they run.

## Durable state and revision tracking

Each flow persists its own state and tracks revisions so progress survives gateway restarts. Revision tracking enables conflict detection when multiple sources attempt to advance the same flow concurrently.

## Cancel behavior

`openclaw tasks flow cancel` sets a sticky cancel intent on the flow. Active tasks within the flow are cancelled, and no new steps are started. The cancel intent persists across restarts, so a cancelled flow stays cancelled even if the gateway restarts before all child tasks have terminated.

## CLI commands

```bash
# List active and recent flows
openclaw tasks flow list

# Show details for a specific flow
openclaw tasks flow show <lookup>

# Retry a failed, lost, or blocked managed child-task flow
openclaw tasks flow retry <lookup>

# Cancel a running flow and its active tasks
openclaw tasks flow cancel <lookup>
```

| Command                           | Description                                                        |
| --------------------------------- | ------------------------------------------------------------------ |
| `openclaw tasks flow list`        | Shows tracked flows with status and sync mode                      |
| `openclaw tasks flow show <id>`   | Inspect one flow by flow id or lookup key                          |
| `openclaw tasks flow retry <id>`  | Relaunch a retryable managed child-task flow from its stored spawn |
| `openclaw tasks flow cancel <id>` | Cancel a running flow and its active tasks                         |

## Task Flow v1 closure state

Task Flow v1 is considered shippable when all of the following are true:

- **Durable orchestration works end-to-end** — managed and mirrored flows persist state across gateway restarts.
- **Recovery is explicit** — managed child-task flows can be retried from `failed`, `lost`, or `blocked` when stored launch data is safely replayable.
- **Unsafe replay is rejected on purpose** — child launches that originally carried inline attachments are marked non-retryable with a durable operator-facing reason instead of attempting a lossy replay.
- **Control surfaces are usable** — CLI and web chat both expose the latest flow's status, reason, retry/cancel affordances, linked task visibility, and lightweight debug state.
- **Operator intent survives restarts** — cancel intent stays sticky and retry/cancel results remain owner-scoped.
- **Validation exists** — targeted gateway, task executor, runtime, command, and UI tests cover the retry/cancel and latest-flow inspection path.

### In scope for v1

- Managed child-task flow creation, status sync, retry, and cancellation
- Mirrored flow tracking for externally created tasks
- Latest-flow visibility in the web chat control surface
- CLI inspection and intervention commands (`list`, `show`, `retry`, `cancel`)
- Durable operator/debuggability metadata: flow id, controller, requester origin, wait/state snapshots, linked task summaries

### Out of scope for v1

- Arbitrary historical flow browsing in the web UI
- Automatic attachment materialization/replay for retried child tasks
- Full DAG/graph editing or visual flow design tooling
- Bulk retry/cancel operations across many flows

### Post-v1 next slices

- A dedicated historical flows view in the web UI with filter/search beyond "latest flow"
- Optional durable attachment replay based on stored blobs or explicit operator re-attach flows
- Higher-fidelity recovery validation for restart-in-the-middle edge cases and merge/post-merge operator acceptance
- Richer observability surfaces such as flow-event timelines and per-step state diffs

## How flows relate to tasks

Flows coordinate tasks, not replace them. A single flow may drive multiple background tasks over its lifetime. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

## Related

- [Background Tasks](/automation/tasks) — the detached work ledger that flows coordinate
- [CLI: tasks](/cli/index#tasks) — CLI command reference for `openclaw tasks flow`
- [Automation Overview](/automation) — all automation mechanisms at a glance
- [Cron Jobs](/automation/cron-jobs) — scheduled jobs that may feed into flows
