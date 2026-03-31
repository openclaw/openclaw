---
summary: "ClawFlow workflow orchestration for background tasks and detached runs"
read_when:
  - You want a flow to own one or more detached tasks
  - You want to inspect or cancel a background job as a unit
  - You want to understand how flows relate to tasks and background work
title: "ClawFlow"
---

# ClawFlow

ClawFlow is the flow layer above [Background Tasks](/automation/tasks). Tasks still track detached work. ClawFlow groups those task runs into a single job, keeps the parent owner context, and gives you a flow-level control surface.

Use ClawFlow when the work is more than a single detached run. A flow can still be one task, but it can also coordinate multiple tasks in a simple linear sequence.

## TL;DR

- Tasks are the execution records.
- ClawFlow is the job-level wrapper above tasks.
- A flow keeps one owner/session context for the whole job.
- Use `openclaw flows list`, `openclaw flows show`, and `openclaw flows cancel` to inspect or manage flows.

## Quick start

```bash
openclaw flows list
openclaw flows show <flow-id-or-owner-session>
openclaw flows cancel <flow-id-or-owner-session>
```

## How it relates to tasks

Background tasks still do the low-level work:

- ACP runs
- subagent runs
- cron executions
- CLI-initiated runs

ClawFlow sits above that ledger:

- it keeps related task runs under one flow id
- it tracks the flow state separately from the individual task state
- it makes blocked or multi-step work easier to inspect from one place

For a single detached run, the flow can be a one-task flow. For more structured work, ClawFlow can keep multiple task runs under the same job.

## CLI surface

The flow CLI is intentionally small:

- `openclaw flows list` shows active and recent flows
- `openclaw flows show <lookup>` shows one flow and its linked tasks
- `openclaw flows cancel <lookup>` cancels the flow and any active child tasks

The lookup token accepts either a flow id or the owner session key.

## Related

- [Background Tasks](/automation/tasks) — detached work ledger
- [CLI: flows](/cli/flows) — flow inspection and control commands
- [Cron Jobs](/automation/cron-jobs) — scheduled jobs that may create tasks
