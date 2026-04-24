---
title: "PENDING.md Template"
summary: "Workspace template for PENDING.md — cross-session commitment tracking"
read_when:
  - Setting up a workspace for multi-day workflows
  - Tracking commitments that must survive session reset
---

# PENDING.md Template

`PENDING.md` is an optional workspace file for tracking cross-session commitments
that should survive session resets, compaction, or multi-day execution boundaries.

It is especially useful for commitments such as:

- multi-day API-limited batch jobs
- follow-ups promised to a user
- manual review tasks with deadlines
- long-running workflows coordinated across multiple sessions

This file is user-maintained and lives in the workspace, following OpenClaw's
"workspace as private memory" model.

> **Note:** `PENDING.md` is a community workspace pattern, not a built-in runtime
> feature. It does not replace Background Tasks, Cron Jobs, Standing Orders, or
> `HEARTBEAT.md`. Instead, it complements them by recording commitments that need
> to remain visible across session boundaries.

## When to Use PENDING.md

Use `PENDING.md` when you need to track:

- commitments that must survive session reset or compaction
- work with a human deadline
- tasks that span multiple sessions or multiple days
- reminders that should be checked periodically via `HEARTBEAT.md`

Do not use `PENDING.md` as a replacement for:

- **Background Tasks** — for tracking active/running background work
- **Cron Jobs** — for scheduling recurring or delayed triggers
- **Standing Orders** — for persistent authorization/rules
- **HEARTBEAT.md** — for periodic checks and reporting logic

A common pattern is:

1. Record the commitment in `PENDING.md`
2. Use `HEARTBEAT.md` to check deadlines periodically
3. Use Background Tasks or Cron for the actual execution
4. Mark the item complete in `PENDING.md` when finished

## Recommended Location

Place this file in your workspace:

```text
~/.openclaw/workspace/PENDING.md
```

## Recommended Entry Format

Use one section per commitment.

**Core fields (recommended):**

- **Committed** — when the commitment was made
- **Deadline** — target completion date/time
- **Description** — what needs to be done
- **Status** — current state
- **Notes** — important execution context

**Optional fields:**

- **Owner** — which agent/user made the commitment
- **Related** — references to sessions, files, jobs, or tickets
- **Next Checkpoint** — when to check progress (for multi-day work)
- **Completion Signal** — what counts as done

**Example status values:**

- Not Started
- In Progress
- Blocked
- Completed
- Cancelled

## Template Example

```md
# PENDING

## Active

### API Batch Job - Data Export

- **Committed**: 2026-04-17
- **Deadline**: 2026-04-22
- **Description**: Export 1000 records via rate-limited API.
- **Status**: In Progress (800/1000 complete)
- **Notes**:
  - API is rate-limited
  - Cron resumes processing at 02:00 daily
  - Resume from the last successful checkpoint
- **Related**:
  - Job: nightly-export
  - Workspace file: reports/export-log.md

### Follow Up - Customer Reply

- **Committed**: 2026-04-18
- **Deadline**: 2026-04-19
- **Description**: Send a summary and next steps after document review.
- **Status**: Not Started
- **Notes**:
  - Wait for final review notes
  - Draft should be concise and action-oriented

## Done

### Weekly Review - Inbox Cleanup

- **Committed**: 2026-04-19
- **Deadline**: 2026-04-20
- **Description**: Review untriaged items and identify action items.
- **Status**: Completed
- **Notes**:
  - Finished during morning review
  - No outstanding action items remain
```

## Minimal Format

If you prefer a lighter format, this also works:

```md
### API Batch Job

- **Deadline**: 2026-04-22
- **Status**: In Progress (800/1000 complete)
- **Notes**: Rate-limited API, resumes nightly via cron
```

The key requirement is that entries remain easy for both the user and the agent
to read and update.

## HEARTBEAT.md Integration

A common pattern is to have `HEARTBEAT.md` periodically inspect `PENDING.md` and
alert the user when an item is overdue.

Example `HEARTBEAT.md` task:

```md
tasks:

- name: pending-tasks-check
  interval: 30m
  prompt: |
  Read PENDING.md if it exists.
  Check each pending item's deadline against the current time.
  If any item is overdue and not completed, report the overdue items.
  If all items are on-track, reply HEARTBEAT_OK.
```

See [Heartbeat](/gateway/heartbeat) for full configuration details.

## Suggested Conventions

To keep `PENDING.md` reliable over time:

- keep entries concise and readable
- use explicit deadlines when possible
- update status when progress changes
- mark completed items clearly instead of silently deleting them
- archive old items periodically if the file grows too large
- prefer plain text and Markdown over custom syntax

Archive pattern:

- keep active items in `PENDING.md`
- move completed or cancelled items to `PENDING-ARCHIVE.md`

## Relationship to Native Mechanisms

`PENDING.md` tracks commitments.

Native mechanisms handle other concerns:

| Mechanism        | Answers                                             |
| ---------------- | --------------------------------------------------- |
| Cron             | When should something run?                          |
| Background Tasks | What is this running job doing?                     |
| Standing Orders  | What is the agent allowed to do persistently?       |
| HEARTBEAT.md     | What needs periodic attention?                      |
| PENDING.md       | What commitment must be remembered across sessions? |

This separation avoids overloading any single mechanism.

## Notes

- `PENDING.md` is optional.
- It is not auto-injected into context.
- The agent must explicitly read it when needed.
- The file is intended to remain transparent, editable, and local to the
  workspace.

This makes it a good fit for OpenClaw's local-first, operator-controlled workflow
model.
