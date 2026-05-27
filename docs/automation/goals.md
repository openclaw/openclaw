---
summary: "Session goals for bounded same-session continuation"
read_when:
  - Using /goal to let an agent continue a current objective
  - Comparing goals with heartbeat, cron, tasks, or queue followups
  - Debugging goal_status or session continuation behavior
title: "Goals"
---

Goals let a trusted sender ask OpenClaw to keep working on one current-session
objective across a small number of follow-up turns. They are explicit, visible,
and bounded: the user starts the goal, the agent reports progress through
`goal_status`, and OpenClaw stops on terminal states or when the continuation
limit is reached.

Goals are useful for work that is already happening in the current session and
needs one more slice after the current assistant turn finishes. They are not a
replacement for scheduled work, detached tasks, or standing instructions.

## Quick start

Enable the bundled goal plugin before using `/goal`:

```bash
openclaw plugins enable goal
```

If your config uses a restrictive `plugins.allow` list, include `goal` there
before enabling it. Otherwise the enable command is blocked and `/goal` will
not be registered:

```bash
openclaw config set plugins.allow '["codex","discord","goal"]'
openclaw plugins enable goal
```

Restart or reload the Gateway after changing plugin configuration so the command
is registered in connected chats.

Start a goal from the current chat:

```text
/goal start finish the release note and verify the touched tests
```

Check the active goal:

```text
/goal status
```

Pause or finish it:

```text
/goal pause waiting for review
/goal done verified locally
```

Clear the visible goal state:

```text
/goal clear no longer needed
```

## Commands

| Command                   | What it does                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `/goal help`              | Shows the command surface.                                                                          |
| `/goal start <objective>` | Starts one visible goal for the current trusted session and schedules the first continuation lease. |
| `/goal status`            | Shows objective, status, continuation count, and the latest note.                                   |
| `/goal events [n]`        | Shows the recent goal decision trail. Defaults to 10 events and caps at 50.                         |
| `/goal pause [note]`      | Stops continuation until a trusted sender resumes.                                                  |
| `/goal resume [note]`     | Reopens a paused goal and schedules another bounded continuation.                                   |
| `/goal done [note]`       | Marks the goal complete. Start a new goal to continue later.                                        |
| `/goal clear [note]`      | Removes the visible goal state and clears any matching continuation lease.                          |

## Agent status tool

When a goal is active, the agent can call `goal_status` with:

| Status             | Effect                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `continue`         | Request one more same-session continuation turn. Only accepted while the goal is already continuing. |
| `done`             | Mark the goal complete and clear the continuation lease.                                             |
| `blocked`          | Mark the goal blocked and clear the continuation lease.                                              |
| `paused`           | Stop continuation until a trusted sender resumes.                                                    |
| `waiting_approval` | Stop continuation because more human approval or a new goal is needed.                               |

The tool uses the host-owned session context. The model cannot choose a
different session or goal id in tool parameters.

## Limits and safety

- One visible goal is stored per trusted session.
- Continuations are same-session only.
- Each `continue` schedules one replacement lease, so duplicate leases for the
  same goal do not fan out.
- Continuation count is capped. When the cap is reached, the goal moves to
  `waiting_approval` and the user can start a new goal if more work is wanted.
- `done`, `blocked`, and the continuation cap are terminal for `/goal resume`.
- `/goal clear` removes the visible goal state and clears the matching lease.

## Goal or another automation

| Need                                                                    | Use                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| Keep working on the current objective for a few more same-session turns | Goals                                          |
| Run a reminder or report at an exact time                               | [Scheduled Tasks](/automation/cron-jobs)       |
| Check routine things every so often with session context                | [Heartbeat](/gateway/heartbeat)                |
| Track detached ACP, subagent, cron, or CLI work                         | [Background Tasks](/automation/tasks)          |
| Give the agent permanent operating instructions                         | [Standing Orders](/automation/standing-orders) |
| React to lifecycle events such as `/new`, `/reset`, or `/stop`          | [Hooks](/automation/hooks)                     |

Goals are deliberately narrower than queue modes. `/queue followup` controls how
incoming user messages wait behind an active run; goals let the active goal
itself request a bounded follow-up turn after it reports progress.

## Related

- [Automation and tasks](/automation)
- [Command queue](/concepts/queue)
- [Slash commands](/tools/slash-commands)
