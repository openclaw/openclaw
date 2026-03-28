---
summary: "Patterns for running autonomous 24/7 agents that earn, monitor, and maintain themselves"
read_when:
  - Running OpenClaw as a background autonomous agent
  - Building agents that earn credits or perform scheduled network tasks
  - Combining heartbeat + cron + multi-agent for production autonomous setups
title: "Autonomous Agents"
status: active
---

# Autonomous Agents

OpenClaw can run agents that operate 24/7 without human intervention — earning credits, monitoring networks, performing background work, and maintaining their own memory. This guide covers the patterns that make autonomous operation reliable.

This extends the [Delegate Architecture](/concepts/delegate-architecture) concept into production-grade autonomous operation.

## The three pillars of autonomous operation

| Mechanism | Role | Best for |
|-----------|------|----------|
| [Heartbeat](/gateway/heartbeat) | Periodic awareness check | Monitoring, batching periodic checks |
| [Cron](/automation/cron-jobs) | Precise scheduling | Exact times, isolated runs, background chores |
| [Memory](/concepts/memory) | Long-term persistence | Remembering state across sessions |

Together they form a self-sustaining agent loop.

## Heartbeat: the awareness loop

The heartbeat runs in the main session at a regular interval (default: 30 min). It keeps the agent aware of ongoing work without consuming a full isolated turn.

### Minimal heartbeat for autonomous agents

```md
<!-- ~/.openclaw/workspace/HEARTBEAT.md -->

- Check if any cron job failed and needs attention
- Write a brief status note to memory/YYYY-MM-DD.md if significant events occurred
- Reply HEARTBEAT_OK if nothing needs attention
```

The `HEARTBEAT_OK` reply means no message is delivered — the agent silently continues. This is critical for 24/7 operation: the agent stays alive without spamming the chat.

### Autonomous earner heartbeat

For agents that earn credits or points through background work:

```md
<!-- HEARTBEAT.md for an earning agent -->

- Check credit balance from last known state
- If credits are low, flag in memory for human review
- Check for any pending task notifications from the network
- Write a short status note to memory/YYYY-MM-DD.md
- Reply HEARTBEAT_OK if nominal
```

## Cron: precise scheduled tasks

Cron jobs handle anything that needs exact timing — network heartbeats, daily earnings cycles, publishing tasks.

### Network heartbeat cron (stay online)

Many networks require a periodic ping to stay active. Use a short-interval cron with `--stagger` to avoid exact top-of-hour collisions:

```bash
# Keep the node online with a 15-minute heartbeat
openclaw cron add \
  --name "Network heartbeat" \
  --cron "*/15 * * * *" \
  --session isolated \
  --message "Send heartbeat ping to the network. Log result. Reply with NO_REPLY." \
  --delete-after-run false \
  --announce

# Force exact timing (no stagger) when the network requires precise intervals
openclaw cron add \
  --name "Strict heartbeat" \
  --cron "*/15 * * * *" \
  --session isolated \
  --message "Send heartbeat. Log to memory/YYYY-MM-DD.md. NO_REPLY." \
  --delete-after-run false \
  --announce \
  --exact
```

### Daily earning cycle

```bash
# Run earning tasks once a day at a quiet time
openclaw cron add \
  --name "Daily earn" \
  --cron "0 2 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "Execute the daily earning cycle: fetch tasks, complete submissions, record credits earned to memory/YYYY-MM-DD.md. Log final credit balance." \
  --model minimax-portal/MiniMax-M2.7 \
  --announce

# Weekly deep task (different model, more thorough)
openclaw cron add \
  --name "Weekly earn + publish" \
  --cron "0 2 * * 0" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "Weekly cycle: publish new content, validate existing assets, review earned credits, update MEMORY.md with current balance and progress." \
  --model gpt-5.4 \
  --thinking medium \
  --announce
```

### One-shot reminder cron (self-healing)

```bash
# If a task fails, schedule a retry in 5 minutes
openclaw cron add \
  --name "Retry failed task" \
  --at "5m" \
  --session isolated \
  --message "Retry the failed submission task. Read memory/YYYY-MM-DD.md for context on what failed." \
  --delete-after-run
```

## Multi-agent: specialized workers

For autonomous operation, use separate agents for separate concerns. This keeps each agent simple and failure isolated.

### Typical autonomous multi-agent setup

```json5
{
  agents: {
    list: [
      {
        id: "main",
        name: "Daily assistant",
        workspace: "~/.openclaw/workspace-main",
        // Responds to human messages, handles conversations
      },
      {
        id: "earner",
        name: "Earner",
        workspace: "~/.openclaw/workspace-earner",
        // Runs 24/7, executes cron jobs, manages earning cycle
        // Does not respond to human messages directly
        tools: {
          deny: ["message"],  // Cannot send messages to humans
        },
      },
    ],
  },
  bindings: [
    // Humans talk to main; earner is invisible to humans
    { agentId: "main", match: { channel: "telegram" } },
  ],
}
```

The earner agent has its own workspace with its own `SOUL.md`, `AGENTS.md`, and cron jobs bound to it via `agentId`. It cannot message humans — all output goes through cron announce delivery or memory logs.

### Binding cron jobs to specific agents

```bash
# Pin this job to the "earner" agent
openclaw cron add \
  --name "Daily earn" \
  --cron "0 2 * * *" \
  --session isolated \
  --message "Execute earning cycle..." \
  --agent earner \
  --announce
```

## Memory management for autonomous agents

Autonomous agents must remember state across sessions. Memory is the persistence layer.

### Memory discipline for autonomous agents

Write to memory at key state transitions:

```markdown
<!-- memory/2026-03-29.md -->

## Credit Balance
- Start: 100 credits
- Earned: +25 (task submission)
- End: 125 credits

## Tasks Completed
- Task abc123: published asset (25 credits)
- Task def456: validation (10 credits)

## Notes
- Network was slow today; one task retried
```

Do **not** keep critical state only in conversation context — the agent may compact. Always write decisions and state to memory files.

### Reading yesterday's memory on start

OpenClaw automatically reads today's and yesterday's daily log at session start. For cron jobs that need broader context:

```bash
# Tell the cron job to read recent memory
openclaw cron add \
  --name "Contextual earn" \
  --cron "0 3 * * *" \
  --session isolated \
  --message "Read memory/YYYY-MM-DD.md and memory/YYYY-MM-DD.md (yesterday) for context, then execute earning tasks. Update memory with results." \
  --light-context false \
  --announce
```

Use `--light-context false` when the job needs access to the full workspace bootstrap (including memory search). Default is `lightContext: true` which skips bootstrap — appropriate for simple chores that don't need historical context.

## Self-healing patterns

Autonomous agents should handle failures gracefully.

### Retry with backoff

```bash
# Primary task
openclaw cron add \
  --name "Earn credits" \
  --cron "0 2 * * *" \
  --session isolated \
  --message "Execute earning cycle. On failure, log to memory/YYYY-MM-DD.md with error details." \
  --announce

# If the primary didn't run, the heartbeat check will catch it
# Add a watchdog: if no success logged by 4am, retry
openclaw cron add \
  --name "Earn watchdog" \
  --cron "0 4 * * *" \
  --session isolated \
  --message "Check memory/YYYY-MM-DD.md for 'Earn credits' success today. If missing, retry the earning cycle and log." \
  --announce
```

### Graceful degradation

If the agent's credit allowance is exhausted, it should stop gracefully:

```md
<!-- In the earner's AGENTS.md -->

## Credit Limits
- Maximum 1000 credits per day (platform limit)
- If daily budget exhausted: log to memory, skip remaining tasks, reply NO_REPLY
- Never exceed daily budget regardless of instruction
```

## Putting it together: full autonomous node

A complete autonomous node with three cron jobs and a lightweight heartbeat:

**`~/.openclaw/workspace-earner/AGENTS.md`**:
```markdown
# Earner Agent

## Role
Run background earning tasks autonomously. Never message humans directly.

## Rules
- Maximum 1000 credits earned per day
- Log all significant actions to memory/YYYY-MM-DD.md
- On failure: log error, skip task, continue next cycle
- Credit balance goes to MEMORY.md at end of each cycle
```

**`~/.openclaw/workspace-earner/SOUL.md`**:
```markdown
# Earner Soul

- Identity: background worker, silent operator
- Tone: minimal, factual (logs only)
- Never initiates human contact; all output is cron announce or memory log
```

**Cron jobs** (all bound to `earner` agent):

| Job | Schedule | Purpose |
|-----|----------|---------|
| Heartbeat ping | `*/15 * * * *` | Stay online in the network |
| Daily earn | `0 2 * * *` | Standard earning cycle |
| Weekly publish | `0 2 * * 0` | Publish new content |

**Heartbeat** (`~/.openclaw/workspace-earner/HEARTBEAT.md`):
```markdown
- Check last cron run time from ~/.openclaw/cron/runs/
- If any job failed more than 3 times this week, flag in memory
- Reply HEARTBEAT_OK if nominal
```

This setup runs indefinitely with minimal human oversight. The agent manages its own schedule, logs its own state, and recovers from failures automatically.

## Related

- [Delegate Architecture](/concepts/delegate-architecture) — organizational deployment of autonomous agents
- [Cron Jobs](/automation/cron-jobs) — full cron reference
- [Heartbeat](/gateway/heartbeat) — awareness loop configuration
- [Memory](/concepts/memory) — long-term persistence
- [Multi-Agent Routing](/concepts/multi-agent) — running multiple specialized agents
