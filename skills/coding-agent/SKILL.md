---
name: coding-agent
description: Run Codex CLI, Claude Code, or OpenCode via background process for programmatic control.
metadata: {"clawdis":{"emoji":"🧩","requires":{"anyBins":["claude","codex","opencode"]}}}
---

# Coding Agent (background-first)

Use **bash background mode** for coding agents. Full programmatic control, no tmux needed.

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

**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files (like your soul.md 😅).

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

**Reasoning effort:** Choose based on task complexity:
- `medium` — most tasks (default)
- `high` — complex/architectural tasks

### Building/Creating (use --full-auto)
```bash
bash workdir:~/project background:true command:"codex exec --full-auto \"Build a snake game with dark theme\""
```

### Reviewing (vanilla, no flags needed)
```bash
bash workdir:~/project background:true command:"codex exec \"Review PR #115. Run git diff origin/main...origin/pr/115 to see changes.\""
```

### Running Multiple Codex Processes
You can run many Codex processes in parallel! Each gets its own session:
```bash
# Start multiple reviews
bash workdir:~/project background:true command:"codex exec \"Review PR #1\""
bash workdir:~/project background:true command:"codex exec \"Review PR #2\""
bash workdir:~/project background:true command:"codex exec \"Review PR #3\""

# Check all running
process action:list
```

### PR Review Tips
- Fetch PR refs first: `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`
- Tell Codex to use: `git diff origin/main...origin/pr/XX`
- Don't let it checkout branches (conflicts with parallel reviews)

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

1. **Respect tool choice** — if user asks for Codex, use Codex. NEVER offer to build it yourself!
2. **Be patient** — don't kill sessions because they're "slow"
3. **Monitor with process:log** — check progress without interfering
4. **--full-auto for building** — auto-approves changes
5. **vanilla for reviewing** — no special flags needed
