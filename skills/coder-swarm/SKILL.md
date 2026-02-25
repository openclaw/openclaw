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
- If PR is not possible, task is marked complete with a reason.

## Operational Notes

- Task registry: `~/.openclaw/agent-tasks.json`
- Use `tmux` to steer running sessions.
- Keep merge as human-in-the-loop unless user explicitly asks for auto-merge workflows.
