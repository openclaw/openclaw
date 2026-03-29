---
title: "Background Task Lifecycle Tracking (PR #52518)"
summary: "Plain-language outline of the durable task registry, quieter background ACP delivery, and new task inspection commands from PR #52518"
author: "Mariano Belinky <mbelinky@gmail.com>"
github_username: "mbelinky"
created: "2026-03-29"
---

# Feature Outline: Background Task Lifecycle Tracking (PR #52518)

## TL;DR

- OpenClaw now treats long-running background work as tracked tasks instead of "something a child session is doing somewhere."
- The system saves task state to disk, so operators can later check what happened even after a restart.
- Background ACP runs are quieter: by default they stop sending raw child-session chatter into the user chat and send one short final update instead.
- You can inspect tasks with `openclaw tasks`, change the notification level, and cancel running ACP or subagent work.

## What problem this solves

Before this PR, background work had a few weak spots:

1. It was hard to tell whether a task was still running, done, failed, or simply disappeared.
2. ACP child sessions could leak setup or progress chatter into the main user thread.
3. After restarts or partial failures, operators sometimes had to inspect sessions or logs manually to reconstruct what happened.

## What changed

### 1. OpenClaw now has a durable task registry

OpenClaw now creates a task record for:

- background ACP work
- subagent runs
- gateway-started background CLI runs

Each record can keep:

- a task ID and run ID
- the runtime (`acp`, `subagent`, or `cli`)
- the requester session and child session
- the current status
- short progress and final summaries
- delivery state and notification policy

The registry is saved under the configured state directory as `tasks/runs.json`, so it can be restored after restart.

### 2. Background ACP runs now report through the parent, not the child

This PR adds a clear split between:

- normal interactive ACP sessions
- parent-owned background ACP sessions

If an ACP oneshot session was spawned from another session, OpenClaw now treats it as background work. In plain terms, the child session should not speak directly in the user-facing chat. Instead, the parent-owned task record handles the final update.

### 3. Default ACP notifications are short and quiet

For background ACP tasks, the default notification policy is `done_only`.

That means the requester normally gets one short message when the task ends, such as:

- done
- failed
- timed out
- lost
- cancelled

This is intentionally quieter than streaming raw child updates into the main conversation.

### 4. Optional state-change updates

If someone wants more visibility, they can switch a task to `state_changes`. Then OpenClaw can send short updates like:

- task started
- no output for a while
- output resumed
- a short progress summary

There is also a `silent` mode if no notifications should be sent.

### 5. New `openclaw tasks` commands

This PR adds a durable operator-facing CLI for task inspection and control:

```bash
openclaw tasks
openclaw tasks list --runtime acp --status running
openclaw tasks show <task-id|run-id|session-key>
openclaw tasks notify <lookup> done_only
openclaw tasks notify <lookup> state_changes
openclaw tasks notify <lookup> silent
openclaw tasks cancel <lookup>
```

This gives operators a direct way to answer "what is this task doing?" without scraping session output.

### 6. Recovery and cleanup

The registry is restored on startup and maintained in the background.

Important behaviors:

- If a task is still marked active but its backing session disappears for long enough, OpenClaw can mark it as `lost`.
- Old finished tasks are pruned after a retention window.
- Task lookup works by task ID, run ID, or session key.

## What users will notice

The biggest user-facing behavior change is for background ACP runs.

Before:

- a background ACP child session could leak raw chatter into the main chat
- the final outcome could be unclear
- "let me know when you're done" was not very reliable

After:

- the main chat stays cleaner
- background ACP work has a durable status record
- the requester can get a single clear final update
- operators can inspect or cancel tasks explicitly

## What operators and maintainers will notice

- ACP, subagent, and background CLI work now share one task-tracking model.
- Task records are linked to the requester session, child session, and run ID.
- Some existing status and info views now surface linked task IDs and delivery state.
- Restart and recovery behavior is stronger because task state is no longer only implicit in session logs.

## Simple example

1. A user asks OpenClaw to do a long ACP job in the background.
2. OpenClaw creates a task record right away.
3. The child ACP session runs in its own session.
4. Progress is tracked in the registry instead of being dumped into the user thread.
5. When the job finishes, OpenClaw sends one short final update back to the original requester.
6. If needed, an operator can inspect or cancel the task with `openclaw tasks`.

## What this feature does not add

This PR is about lifecycle tracking and delivery behavior. It does not add:

- a new UI
- automatic retries
- a general-purpose job queue

## Main takeaway

This feature makes background work feel like a real first-class task instead of hidden session state. The main win is reliability: OpenClaw can now track, recover, inspect, notify, and cancel background work in a much more predictable way.

Source PR: https://github.com/openclaw/openclaw/pull/52518
