---
summary: "Evolution of OpenClaw Heartbeat: from passive checks to proactive monitoring and self-iteration"
title: Proactive Heartbeat Best Practices
read_when:
  - You want to make your agent more proactive
  - You are optimizing heartbeat configurations for cost and effectiveness
  - You are integrating heartbeat with other automation patterns
---

# Proactive Heartbeat: Best Practices

The OpenClaw `heartbeat` is a powerful mechanism for agent proactivity. It evolves beyond simple health checks into a comprehensive system for monitoring, task nudging, and self-improvement.

This guide outlines a 4-stage evolution, drawing from real-world deployments to demonstrate how to maximize your agent's proactive capabilities while optimizing token usage.

## The 4-Stage Evolution of Heartbeat

Most agent deployments start with a basic heartbeat and expand its responsibilities as the agent matures.

### Stage 1: Passive Recovery (Basic Setup)

This is the initial state for many agents. The heartbeat's primary role is to ensure continuity after interruptions.

**Purpose**: To check if any background tasks crashed or if the agent needs to resume work.

**HEARTBEAT.md content (minimal)**:

```md
# Heartbeat Checklist - Stage 1: Passive Recovery

- Check `~/.openclaw/recovery/restart-signal.json` for unrecovered restarts.
- Review `active_tasks.json` for `in_progress` tasks with dead processes.
- Check `memory/YYYY-MM-DD.md` for `pending_confirmation` and `PENDING_TASKS`.
```

**Characteristics**:

- **Reactive**: Only responds if a problem is detected.
- **Low token usage**: Minimal checks, small `HEARTBEAT.md`.
- **Limited proactivity**: Does not actively seek out new issues or prompt the user.

### Stage 2: Active System Monitoring (Infrastructure Awareness)

At this stage, the heartbeat expands to monitor the agent's operational environment and critical services.

**Purpose**: To ensure the underlying infrastructure is healthy and to detect potential issues before they impact operations.

**HEARTBEAT.md content (extended)**:

```md
# Heartbeat Checklist - Stage 2: Active System Monitoring

## 1. Recovery Checks (Inherited from Stage 1)
- Check `~/.openclaw/recovery/restart-signal.json` for unrecovered restarts.
- Review `active_tasks.json` for `in_progress` tasks with dead processes.
- Check `memory/YYYY-MM-DD.md` for `pending_confirmation` and `PENDING_TASKS`.

## 2. System Patrol (New)
- **Tailscale**: Check `/Applications/Tailscale.app/Contents/MacOS/Tailscale status`.
  - *Action*: If stopped, attempt auto-restart.
- **Disk Space**: Monitor `df -h /` for all partitions.
  - *Threshold*: Alert if any partition >85% usage.
- **Pipeline Health**: Query pipeline DB for recent failures.
  - *Action*: Report failures/stalls.
- **OpenClaw Gateway**: Verify `openclaw gateway status`.
  - *Action*: Report warning/error messages.
- **Key Processes**: Ensure critical background processes are running.
  - *Action*: Report if missing.
```

**Characteristics**:

- **Proactive detection**: Identifies infrastructure issues without user intervention.
- **Self-healing**: Attempts to fix simple issues (e.g., restart Tailscale).
- **Early warning**: Alerts user to non-critical but important issues.

### Stage 3: Task Nudging (Project Management)

Integrating basic project management. The heartbeat helps ensure tasks don't fall through the cracks.

**Purpose**: To keep ongoing tasks visible and to prompt action on stalled items.

**HEARTBEAT.md content (further extended)**:

```md
# Heartbeat Checklist - Stage 3: Task Nudging

## 1. Recovery Checks (Inherited)
## 2. System Patrol (Inherited)

## 3. Task Nudge (New)
- **Pending Tasks**: Review PENDING_TASKS from recent daily memories.
  - *Action*: If a task is todo or blocked for >3 days, send a reminder.
  - *Action*: If a blocked task's condition is resolved, prompt for next steps.
- **Lessons Learned**: Check memory/lessons_learned.md for action_required items.
  - *Action*: Remind if unaddressed.
- **Cron Job Errors**: Monitor cron job list for consecutiveErrors > 0.
  - *Action*: Report failed cron jobs.
```

**Characteristics**:

- **Active reminder**: Prevents tasks from being forgotten.
- **Improved workflow**: Helps manage multi-step processes and follow up on dependencies.
- **User engagement**: Gentle prompts to keep projects moving.

### Stage 4: Self-Iteration (Agent Self-Improvement)

The most advanced stage, where the agent actively participates in its own development and optimization.

**Purpose**: To formalize learning from experience, adapt strategies, and optimize its own operation.

**HEARTBEAT.md content (full example)**:

```md
# Heartbeat Checklist - Stage 4: Self-Iteration

## 1. Recovery Checks (Inherited)
## 2. System Patrol (Inherited)
## 3. Task Nudge (Inherited)

## 4. Self-Review Trigger (New)
- **Weekly Review**: Check memory/last_weekly_review.md date.
  - *Action*: If >7 days since last review, perform the self-review process:
    1. Review past 7 days of memory/YYYY-MM-DD.md.
    2. Review memory/lessons_learned.md for action_required items.
    3. Extract patterns (successes, recurring issues, user feedback).
    4. Update AGENTS.md, SOUL.md, TOOLS.md as needed.
    5. Record review date + summary to memory/last_weekly_review.md.
    6. Announce completion to user.
```

**Characteristics**:

- **Continuous learning**: Systematically integrates lessons learned.
- **Adaptive behavior**: Evolves its own rules and persona based on experience.
- **Improved efficiency**: Identifies and automates recurring tasks, optimizes configurations.

## Optimizing Heartbeat for Cost and Effectiveness

### Use activeHours to save tokens

Configure `activeHours` to prevent heartbeats from running during inactive periods (e.g., overnight). This significantly reduces token consumption without impacting responsiveness when needed.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "1h",
        activeHours: { start: "08:00", end: "24:00" },
      },
    },
  },
}
```

### Keep HEARTBEAT.md concise

Every line in `HEARTBEAT.md` contributes to the token count of each heartbeat turn. Move infrequent or heavy tasks to isolated cron jobs instead.

### Suppress HEARTBEAT_OK responses

When nothing needs attention, OpenClaw can suppress the `HEARTBEAT_OK` message to avoid flooding chat. This is the default behavior on most channels.

## Integrating Heartbeat with Other Patterns

### Heartbeat + Cron for balanced automation

- **Heartbeat**: For frequent, lightweight checks and context-aware nudges.
- **Cron**: For precise scheduling of heavier, isolated tasks (e.g., weekly deep dives, monthly reports).

This hybrid approach maximizes efficiency while keeping token costs in check.

### Heartbeat + Multi-Agent Coordination

- A coordinator agent uses heartbeat to monitor the overall system and nudge specialist agents as needed via `sessions_send`.
- Specialists only run heartbeats if they have autonomous background responsibilities.

## Related

- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — detailed comparison for scheduling decisions
- [Memory](/concepts/memory) — how agents persist state and knowledge
- [Multi-Agent Orchestration Patterns](/concepts/multi-agent-patterns) — advanced team structures
