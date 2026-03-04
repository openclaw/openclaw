---
summary: "Run coding agents (Claude Code, Codex, Aider) in tmux sessions managed by OpenClaw for long-running dev tasks"
read_when:
  - Running coding agents through OpenClaw
  - Using tmux to prevent timeouts on long dev tasks
  - Automating code review and deployment pipelines
  - Managing Claude Code or similar tools via agents
title: "Coding Agents in tmux"
---

# Coding Agents in tmux

OpenClaw agents can drive coding tools like **Claude Code**, **Codex CLI**, or **Aider**
inside tmux sessions, preventing timeout issues and enabling long-running
development workflows.

---

## Why tmux?

Coding agents often need 1–10+ minutes for complex tasks (code review, large refactors,
multi-file generation). Running them directly via `exec` risks timeouts. tmux solves this:

- **No timeout interrupts** — the process runs independently of OpenClaw's exec timeout
- **Background operation** — the agent can check progress periodically
- **Reconnectable** — attach to see live output anytime
- **Parallel tasks** — run multiple coding sessions simultaneously

---

## Basic Pattern

### 1. Start a tmux session and run the coding agent

```bash
# Create a new tmux session
tmux new-session -d -s dev-task

# Navigate to the project
tmux send-keys -t dev-task "cd /path/to/project" Enter

# Run the coding agent
tmux send-keys -t dev-task "claude 'implement feature X'" Enter
```

### 2. Monitor progress

```bash
# Capture the current output
tmux capture-pane -t dev-task -p | tail -50
```

### 3. Clean up when done

```bash
tmux kill-session -t dev-task
```

---

## Claude Code Integration

### Setup

Install Claude Code and configure it for non-interactive use:

```bash
npm install -g @anthropic-ai/claude-code
```

### Agent workflow (in AGENTS.md)

```markdown
## Development Workflow

**For all coding tasks, use Claude Code in tmux:**

1. Always `git pull` first
2. Create a tmux session
3. Run Claude Code with the task
4. Monitor progress by capturing pane output
5. Review the result
6. Git commit and push when approved

### Example:

\`\`\`bash
cd /path/to/project && git pull
tmux new-session -d -s claude-work
tmux send-keys -t claude-work "cd /path/to/project" Enter
tmux send-keys -t claude-work "claude --dangerously-skip-permissions 'task description'" Enter

# Wait, then check:

tmux capture-pane -t claude-work -p | tail -50
\`\`\`
```

### Handling the permissions prompt

Claude Code may show a permissions bypass prompt. Send navigation keys:

```bash
# Accept the bypass prompt (Down arrow + Enter)
tmux send-keys -t claude-work Down Enter
```

### Monitoring long tasks

For tasks that take several minutes, check periodically:

```bash
# Quick status check
tmux capture-pane -t claude-work -p -S -200 | tail -80

# Look for completion indicators
tmux capture-pane -t claude-work -p | grep -E "Done|Complete|✓|committed"
```

---

## Automated Development Pipeline

### Scheduled code tasks with cron

```bash
# Daily dependency update check
openclaw cron add \
  --name "Dependency check" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --agent dev \
  --message "Run npm audit and check for outdated packages in the project. Use Claude Code in tmux to review and update any safe-to-update dependencies. Commit changes if any." \
  --announce
```

### SEO page generation pipeline

A real-world example — automating SEO landing page creation:

```bash
# Triggered by the growth agent via sessions_send or cron
openclaw cron add \
  --name "SEO page creator" \
  --cron "0 10 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --agent dev \
  --message "Check /path/to/shared/seo-queue/pending.json for new keywords. For each keyword, use Claude Code in tmux to create the SEO page with translations. Follow the project's established page structure. Git push when done. Update the queue." \
  --announce
```

---

## Batch Operations with Shell Scripts

For repetitive tasks, create a shell script and have the coding agent execute it:

```bash
#!/bin/bash
# batch-create.sh — run inside tmux
set -e
cd /path/to/project

ITEMS=("item1" "item2" "item3")
for item in "${ITEMS[@]}"; do
  echo "=== Processing $item ==="
  # ... generate files, update configs ...
  git add -A
  git commit -m "feat: add $item"
  git push
  echo "=== $item DONE ==="
done
```

Then from the OpenClaw agent:

```bash
tmux new-session -d -s batch
tmux send-keys -t batch "bash /path/to/batch-create.sh" Enter
# Monitor:
tmux capture-pane -t batch -p | tail -50
```

This is faster than running Claude Code for each item individually.

---

## Multiple Coding Sessions

Run parallel coding tasks in separate tmux sessions:

```bash
# Frontend work
tmux new-session -d -s frontend
tmux send-keys -t frontend "cd /project && claude 'fix mobile responsive issues'" Enter

# Backend work
tmux new-session -d -s backend
tmux send-keys -t backend "cd /project && claude 'optimize API endpoints'" Enter

# Check all sessions
tmux list-sessions

# Monitor each
tmux capture-pane -t frontend -p | tail -30
tmux capture-pane -t backend -p | tail -30
```

---

## Git Workflow Integration

### Pre-push review

```markdown
## Before Pushing (in AGENTS.md)

Checklist before every push:

- [ ] Claude Code reviewed the changes
- [ ] No console.log() in production code
- [ ] No breaking changes
- [ ] Tests pass
- [ ] Clear commit message
- [ ] No secrets hardcoded
```

### Automated review + push

```bash
# Run Claude Code for review
tmux new-session -d -s review
tmux send-keys -t review "cd /project" Enter
tmux send-keys -t review "claude 'review all uncommitted changes, check for bugs, security issues, and code quality. If everything looks good, commit and push.'" Enter
```

---

## Troubleshooting

### tmux session already exists

```bash
# Kill existing session before creating a new one
tmux kill-session -t claude-work 2>/dev/null
tmux new-session -d -s claude-work
```

### Claude Code stalls (no token progress)

If Claude Code's API connection stalls:

```bash
# Interrupt the current operation
tmux send-keys -t claude-work C-c

# Send a simpler, more direct instruction
tmux send-keys -t claude-work "Use bash commands directly to complete the task" Enter
```

### Capturing output is empty

```bash
# Use -S flag to capture scrollback buffer
tmux capture-pane -t claude-work -p -S -200 | tail -100
```

### Multiple commands queued in tmux

tmux input buffer can queue keystrokes. Wait between commands:

```bash
tmux send-keys -t session "command1" Enter
sleep 2
tmux send-keys -t session "command2" Enter
```

---

## See Also

- [Cron jobs](/automation/cron-jobs) — scheduling automated tasks
- [Multi-agent routing](/concepts/multi-agent) — dedicated dev agents
