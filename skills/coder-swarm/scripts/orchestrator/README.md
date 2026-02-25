# Agent Orchestrator

Parallel coding agent orchestration system for spawning Codex, Claude Code, and Gemini agents in isolated git worktrees.

Inspired by Elvis Sun's agent swarm setup and Stripe's Minions system.

## Architecture

```
Orchestrator (Clawd/Monty/Sterling/Gilfoyle)
  ↓
spawn-agent.sh → creates worktree + launches agent in tmux
  ↓
check-agents.sh (cron every 10m) → monitors CI/PR status
  ↓
notify via MCP → Telegram notification when ready
  ↓
human reviews → merge
  ↓
cleanup-agent.sh → removes worktree/branches
```

## Supported Agents

- **Codex** (gpt-5.3-codex) — Backend logic, complex bugs, multi-file refactors
- **Claude Code** (claude-opus-4.5) — Frontend work, git ops, faster iteration
- **Gemini** (gemini-3-pro-preview) — UI design specs

## Installation

```bash
# Make scripts executable
chmod +x /home/clawd/gilfoyle/tools/agent-orchestrator/bin/*.sh

# Add to PATH (optional)
export PATH="/home/clawd/gilfoyle/tools/agent-orchestrator/bin:$PATH"

# Set up cron monitoring (runs every 10 minutes)
crontab -e
# Add this line:
*/10 * * * * /home/clawd/gilfoyle/tools/agent-orchestrator/bin/check-agents.sh --notify

# Set CLAWD_TOKEN for MCP notifications
export CLAWD_TOKEN="062d36430ad4963afe8d5d3305f852427553be50d078d483"
```

## Usage

### Spawn an Agent

```bash
# Basic usage (defaults to Codex on mac-mini)
spawn-agent.sh --task "Fix billing calculation bug in Stripe webhook"

# Specify agent
spawn-agent.sh --task "Build new dashboard UI" --agent claude

# Specify repo and host
spawn-agent.sh --task "Optimize database queries" \
  --agent codex \
  --repo /home/clawd/Projects/myapp \
  --host beelink2
```

### Monitor Progress

```bash
# Check all running agents (verbose)
check-agents.sh --verbose

# Run with notifications (usually via cron)
check-agents.sh --notify
```

### Mid-Task Steering

Agent going the wrong direction? Don't kill it — steer it:

```bash
# Find the tmux session name
cat ~/.openclaw/agent-tasks.json | jq -r '.tasks[] | select(.status=="running") | .tmuxSession'

# Send guidance (on the host where agent is running)
tmux send-keys -t agent-task-1234 "Stop. Focus on the API layer first, not the UI." Enter

# Need to provide context
tmux send-keys -t agent-task-1234 "The schema is in src/types/user.ts. Use that." Enter
```

### Cleanup Completed Tasks

```bash
# Cleanup specific task (removes worktree and branches)
cleanup-agent.sh agent-task-1234

# Force cleanup even if not marked done
cleanup-agent.sh agent-task-1234 --force

# Auto-cleanup old tasks (>7 days)
source /home/clawd/gilfoyle/tools/agent-orchestrator/lib/task-registry.sh
cleanup_old_tasks 7
```

## Task Registry

All running tasks are tracked in `~/.openclaw/agent-tasks.json`:

```json
{
  "tasks": [
    {
      "id": "agent-task-1708819200-a3f4",
      "agent": "codex",
      "repo": "/home/clawd/Projects/openclaw",
      "branch": "agent-task/agent-task-1708819200-a3f4",
      "worktree": "/tmp/agent-worktrees/agent-task-1708819200-a3f4",
      "host": "mac-mini",
      "tmuxSession": "agent-agent-task-1708819200-a3f4",
      "description": "Fix billing bug in Stripe webhook",
      "startedAt": 1708819200000,
      "status": "running",
      "notifyOnComplete": true,
      "pr": 342,
      "checks": {
        "ciPassed": true
      }
    }
  ]
}
```

## Monitoring

The `check-agents.sh` script is **deterministic** and **token-efficient**:

- No agent polling (expensive)
- Checks tmux session status
- Checks git/GitHub for PR creation
- Checks CI status via `gh` CLI
- Only notifies when status changes

## Host Routing

Agents with `preferredHost: "mac-mini"` in `config/agents.json` will execute on the Mac Mini node.

Tasks requiring macOS tooling automatically route there. The orchestrator uses:

- `openclaw nodes run` for Mac Mini execution
- SSH for other remote hosts
- Local execution when `host=local`

## Configuration

Edit `/home/clawd/gilfoyle/tools/agent-orchestrator/config/agents.json` to customize:

- Command paths
- Model selection
- Flags and options
- Preferred execution host

## Workflow Example

```bash
# 1. Spawn agent for a customer feature request
spawn-agent.sh --task "Add template system for agency customer - save/edit configs" --agent codex

# Output:
# ==> Spawning codex agent
#     Task: Add template system...
#     ID: agent-task-1708819200-a3f4
#     Host: mac-mini
#     Repo: /home/clawd/Projects/openclaw

# 2. Agent works in background (tmux session on mac-mini)
# Creates worktree, installs deps, writes code, commits, creates PR

# 3. Cron job checks status every 10 minutes
# Detects PR creation, checks CI status

# 4. When CI passes, you get notified via Telegram:
# "✅ Agent task ready: Add template system for agency customer
#  PR #342 - CI passed"

# 5. Review PR, merge

# 6. Cleanup
cleanup-agent.sh agent-task-1708819200-a3f4
```

## Tips

- **Parallel work**: Spawn multiple agents for different tasks. They work in isolated worktrees.
- **Context matters**: Give agents specific context in the task description (file paths, schemas, etc.)
- **Steer, don't kill**: Use `tmux send-keys` to redirect agents mid-task.
- **RAM is the bottleneck**: Each worktree needs `node_modules`. Monitor system RAM.

## Troubleshooting

### Agent session died without creating PR

Check logs:

```bash
# View tmux session output (if still alive)
tmux attach -t agent-task-1234

# Or check git log in the worktree
cd /tmp/agent-worktrees/agent-task-1234
git log
```

### CI failed

The agent will retry or you can steer it:

```bash
tmux send-keys -t agent-task-1234 "Fix the linting errors in src/api/" Enter
```

### Mac Mini node unreachable

Check Tailscale connectivity:

```bash
tailscale ping mac-mini
openclaw nodes status
```

## Integration with Orchestrators

From any orchestrator agent (Clawd/Monty/Sterling/Gilfoyle):

```typescript
// Spawn a Codex agent for a bug fix
exec({
  command: "/home/clawd/gilfoyle/tools/agent-orchestrator/bin/spawn-agent.sh",
  args: [
    "--task",
    "Fix race condition in payment processing",
    "--agent",
    "codex",
    "--repo",
    "/home/clawd/Projects/myapp",
  ],
});
```

The orchestrator can then monitor `~/.openclaw/agent-tasks.json` and decide when to intervene or spawn additional agents.

## References

- Elvis Sun's agent swarm: [Twitter thread](https://twitter.com/elvissun)
- Stripe Minions: Background agent orchestration
- OpenClaw subagents: `/docs/features/subagents.md`
