---
summary: "Guide to automating multiple Codex CLI sessions with tmux, watchdog, and OpenClaw"
read_when:
  - You want to run multiple Codex CLI sessions in parallel
  - You need automated nudging, task queues, and completion notifications
  - You want to integrate Codex automation with Discord/Telegram
title: "Multi-project Codex Automation"
---

# Multi-project Codex CLI Automation with OpenClaw

Run multiple Codex CLI sessions in parallel with automated monitoring, intelligent nudging, task queues, and completion notifications — all orchestrated through OpenClaw.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐ │
│  │  Discord  │  │  Claude   │  │ Heartbeat │  │  Cron  │ │
│  │  Channel  │  │ Sub-agent │  │  Checks   │  │  Jobs  │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └───┬────┘ │
└───────┼──────────────┼──────────────┼────────────┼──────┘
        │              │              │            │
        ▼              ▼              ▼            ▼
   Task Queue      Code Review    Status Check  Daily Report
        │              │              │            │
        └──────────────┴──────────────┴────────────┘
                            │
                    ┌───────▼────────┐
                    │  watchdog.sh   │  ← 10s tick loop
                    │  (launchd)     │
                    └───────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  tmux:   │  │  tmux:   │  │  tmux:   │
        │ Project1 │  │ Project2 │  │ Project3 │
        │  codex   │  │  codex   │  │  codex   │
        └──────────┘  └──────────┘  └──────────┘
```

## Quick Start

### 1. Set Up tmux Sessions

```bash
# Create a tmux session with windows for each project
tmux new-session -s autopilot -n MyApp -d
tmux new-window -t autopilot -n Backend
tmux new-window -t autopilot -n Frontend

# Start Codex in each window
tmux send-keys -t autopilot:MyApp 'cd /path/to/myapp && codex' Enter
tmux send-keys -t autopilot:Backend 'cd /path/to/backend && codex' Enter
tmux send-keys -t autopilot:Frontend 'cd /path/to/frontend && codex' Enter
```

### 2. Install codex-autopilot Skill

```bash
# Via ClawHub
clawhub install codex-autopilot

# Or manually
git clone https://github.com/imwyvern/AIWorkFlowSkill.git ~/.autopilot
```

### 3. Configure Projects

```yaml
# ~/.autopilot/config.yaml
project_dirs:
  - "/path/to/myapp"
  - "/path/to/backend"
  - "/path/to/frontend"
```

### 4. Start the Watchdog

```bash
# Direct
nohup bash ~/.autopilot/scripts/watchdog.sh &

# Or via launchd (macOS)
launchctl load ~/.autopilot/com.autopilot.watchdog.plist
```

## Core Concepts

### Intelligent Nudging

The watchdog doesn't blindly nudge idle Codex sessions. It follows a decision tree:

```
Codex idle
├─ Has queue task? → Send task to Codex
├─ Has autocheck issues? → Nudge to fix
├─ Has PRD failures? → Nudge to fix
├─ Has dirty git tree? → Nudge to commit
└─ Nothing to do? → Stay quiet (save tokens!)
```

**Key principle: No task = no nudge.** This prevents token waste from empty nudging.

### Task Queue

Submit tasks when Codex is busy — they'll be dispatched when idle:

```bash
# Add a task
~/.autopilot/scripts/task-queue.sh add myapp "Fix the login page white screen bug" high

# View queue
~/.autopilot/scripts/task-queue.sh list myapp

# Tasks are auto-dispatched by watchdog when Codex goes idle
```

### Task Tracking & Completion Notifications

When you send a task to Codex via `tmux-send.sh`, it's automatically tracked:

```bash
# External calls auto-track by default
~/.autopilot/scripts/tmux-send.sh MyApp "Fix the authentication bug"

# Watchdog monitors: new commit + Codex idle = task complete
# → Discord notification sent to source channel
# → If no progress for 1 hour → "task may be stuck" warning
```

### Discord Integration

Map Discord channels to projects for bidirectional communication:

```yaml
# ~/.autopilot/config.yaml
discord_channels:
  myapp:
    channel_id: "123456789"
    tmux_window: "MyApp"
    project_dir: "/path/to/myapp"
```

- Project commits → auto-posted to Discord channel
- Task completion → notification in source channel
- Code review results → posted to channel

## Integration with OpenClaw

### Claude as Code Reviewer

OpenClaw's Claude sub-agents can perform code reviews while Codex writes code:

```
Codex commits code → watchdog detects N commits
→ triggers review → Claude sub-agent analyzes
→ issues found → nudges Codex to fix
→ review clean → notifies user
```

### Discord → Codex Task Routing

Your OpenClaw assistant receives Discord messages and routes code tasks to Codex:

```
User in #myapp: "Fix the login bug"
→ Assistant classifies as code task
→ task-queue.sh add myapp "Fix the login bug"
→ Watchdog dispatches to Codex when idle
→ Codex fixes → commits → watchdog notifies Discord
```

### Heartbeat Monitoring

Use OpenClaw heartbeats to periodically check project status and report:

```markdown
# HEARTBEAT.md

- Check Codex status across all projects
- Report any stuck or erroring sessions
```

## Best Practices

### Token Conservation

1. **No task = no nudge** — Don't nudge idle sessions without work
2. **Review issue backoff** — Stop nudging after 5 failed review-fix attempts
3. **Queue tasks** — Batch work instead of constant nudging
4. **Monitor usage** — Track daily token consumption per project

### Reliability

1. **Confirm task receipt** — Check Codex enters `working` state after sending
2. **Timeout protection** — Queue tasks auto-fail after 1 hour of no progress
3. **Concurrent locks** — Prevent parallel operations on same queue file
4. **Atomic writes** — Use write-to-tmp + rename pattern for state files

### Multi-project Coordination

1. **One Codex per project** — Don't share tmux windows across repos
2. **Isolated state** — Each project has its own nudge counters, queue, review state
3. **No parallel editing** — Don't run sub-agents on repos where Codex is active
4. **Staggered reviews** — Don't trigger reviews for all projects simultaneously

## Troubleshooting

| Symptom                       | Cause                       | Fix                                          |
| ----------------------------- | --------------------------- | -------------------------------------------- |
| Codex not responding to nudge | TUI stalled or process dead | Check `codex-status.sh`, restart if `absent` |
| Queue task stuck in-progress  | Codex crashed mid-task      | Watchdog auto-recovers after 1 hour timeout  |
| Too many nudges, no commits   | Stuck in review-fix loop    | Backoff kicks in after 5 attempts            |
| Discord notifications missing | Channel mapping wrong       | Check `config.yaml` channel IDs              |

## Resources

- **ClawHub Skill:** [codex-autopilot](https://clawhub.ai/skills/codex-autopilot)
- **Source:** [github.com/imwyvern/AIWorkFlowSkill](https://github.com/imwyvern/AIWorkFlowSkill)
- **OpenClaw Docs:** [docs.openclaw.ai](https://docs.openclaw.ai)
