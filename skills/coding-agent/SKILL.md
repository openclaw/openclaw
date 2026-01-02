---
name: coding-agent
description: Run Claude Code, Codex CLI, or OpenCode via tmux for resilient coding sessions.
metadata: {"clawdis":{"emoji":"🧩","requires":{"bins":["tmux"],"anyBins":["claude","codex","opencode"]}}}
---

# Coding Agent (tmux-first)

Use **tmux** for all coding-agent CLIs. Keep sessions resumable and logs visible.

## The Pattern: workdir + tmux

**All coding agents need this pattern:**

```bash
# Start agent in target directory ("little box" - only sees relevant files)
bash workdir:~/project/folder command:"tmux new -d -s task-name '<agent command>'"

# Monitor progress
tmux capture-pane -t task-name -p | tail -20

# Attach to watch live
tmux attach -t task-name
```

Why workdir matters: Agent wakes up in a focused directory, doesn't wander off reading unrelated files.

---

## Codex CLI

**Model:** `gpt-5.2-codex` with reasoning effort (choose based on task):
- `medium` — most tasks
- `high` — complex/architectural tasks

```bash
bash workdir:~/project command:"tmux new -d -s codex-task 'codex exec --model gpt-5.2-codex -c reasoning_effort=\"medium\" -s workspace-write \"Your task\"'"
```

**Interactive:**
- `codex "prompt"` / `codex resume` / `codex resume --last`

**Flags:** `-s workspace-write`, `--full-auto`, `--skip-git-repo-check`

---

## Claude Code

```bash
bash workdir:~/project command:"tmux new -d -s claude-task 'claude \"Your task\"'"
```

**Interactive:**
- `claude` — start session
- `claude -c` — continue most recent
- `claude -r ""` — picker

---

## OpenCode

```bash
bash workdir:~/project command:"tmux new -d -s opencode-task 'opencode run \"Your task\"'"
```

**Interactive:**
- `opencode` / `opencode -c` / `opencode -s <session-id>`

---

## ⚠️ Rules

1. **Respect tool choice** — if user asks for Codex, use Codex. Don't offer to build it yourself!
2. **Be patient** — don't kill sessions because they're "slow"
3. **Monitor, don't interfere** — use `tmux capture-pane` to watch progress
