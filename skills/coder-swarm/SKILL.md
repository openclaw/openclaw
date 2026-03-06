---
name: coder-swarm
description: Orchestrate Codex, Claude Code, or Gemini coding agents in isolated git worktrees with tmux tracking, PR/CI monitoring, and cleanup. Use when spawning parallel coding tasks, steering long-running coding sessions, or checking status of agent-run branches.
---

# Coding Swarm Orchestrator

Use this skill to run coding agents safely with worktree isolation.

## Commands

- Spawn task:
  - `scripts/swarm-spawn.sh --task "..." --repo /abs/path --agent codex|claude|gemini [--host auto|local|mac-mini|beelink2]`
- Check tasks:
  - `scripts/swarm-check.sh [--verbose] [--notify]`
- Cleanup:
  - `scripts/swarm-cleanup.sh <task-id> [--force]`

## Guardrails

- `--repo` is required (no implicit default repo).
- Work always runs in a new git worktree + branch.
- No destructive git operations by default.
- PR creation is attempted automatically when possible (`gh` available).
- PRs always target the fork (`origin`) by default, never upstream.
- If upstream remote is `openclaw/openclaw`, spawning is refused unless `--target-upstream` is passed.
- If PR is not possible, task is marked complete with a reason.

## PR Targeting

By default agents open PRs against the `origin` fork, not upstream. To target upstream explicitly:

```bash
# Via CLI flag
scripts/swarm-spawn.sh --task "..." --repo /path --target-upstream

# Via environment variable
SWARM_PR_TARGET=upstream scripts/swarm-spawn.sh --task "..." --repo /path
```

Use `pr-safe-create.sh` (in `orchestrator/bin/`) as a drop-in for `gh pr create` anywhere you need the same fork-safety guarantees.

## Operational Notes

- Task registry: `~/.openclaw/agent-tasks.json`
- Use `tmux` to steer running sessions.
- Keep merge as human-in-the-loop unless user explicitly asks for auto-merge workflows.
