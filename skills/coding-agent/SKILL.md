---
name: coding-agent
description: Run Claude Code, Codex CLI, or OpenCode via background process for programmatic control.
metadata: {"clawdis":{"emoji":"🧩","requires":{"anyBins":["claude","codex","opencode"]}}}
---

# Coding Agent (background-first)

Use **bash background mode** for all coding-agent CLIs. Full programmatic control, no tmux needed.

## The Pattern: workdir + background

```bash
# Start agent in target directory ("little box" - only sees relevant files)
bash workdir:~/project/folder background:true command:"<agent command>"
# Returns sessionId for tracking

# Monitor progress
process action:log sessionId:XXX

# Check if done
process action:poll sessionId:XXX

# Send input (if agent asks a question)
process action:write sessionId:XXX data:"y"

# Kill if needed
process action:kill sessionId:XXX
```

Why workdir matters: Agent wakes up in a focused directory, doesn't wander off reading unrelated files.

---

## Codex CLI

**Model:** `gpt-5.2-codex` — choose reasoning effort based on task:
- `medium` — most tasks
- `high` — complex/architectural tasks

```bash
bash workdir:~/project background:true command:"codex exec --model gpt-5.2-codex -c reasoning_effort=\"medium\" -s workspace-write \"Your task\""
```

**Flags:** `-s workspace-write`, `--full-auto`, `--skip-git-repo-check`

---

## Claude Code

```bash
bash workdir:~/project background:true command:"claude \"Your task\""
```

---

## OpenCode

```bash
bash workdir:~/project background:true command:"opencode run \"Your task\""
```

---

## ⚠️ Rules

1. **Respect tool choice** — if user asks for Codex, use Codex. Don't offer to build it yourself!
2. **Be patient** — don't kill sessions because they're "slow"
3. **Monitor with process:log** — check progress without interfering
