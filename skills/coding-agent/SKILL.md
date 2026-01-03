---
name: coding-agent
description: Run Codex CLI, Claude Code, or OpenCode via background process for programmatic control.
metadata: {"clawdis":{"emoji":"🧩","requires":{"anyBins":["claude","codex","opencode"]}}}
---

# Coding Agent (background-first)

Use **bash background mode** for coding agents. Full programmatic control, no tmux needed.

## The Pattern: workdir + background

```bash
# Create temp space for chats/scratch work
SCRATCH=$(mktemp -d)

# Start agent in target directory ("little box" - only sees relevant files)
bash workdir:$SCRATCH background:true command:"<agent command>"
# Or for project work:
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

### Building/Creating (use --full-auto)
```bash
bash workdir:~/project background:true command:"codex exec --full-auto \"Build a snake game with dark theme\""
```

### Reviewing PRs (vanilla, no flags)
```bash
bash workdir:~/project background:true command:"codex exec \"Review PR #115. Use: git diff origin/main...origin/pr/115\""
```

### Batch PR Reviews (parallel army!)
```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy the army - one Codex per PR!
bash workdir:~/project background:true command:"codex exec \"Review PR #86. git diff origin/main...origin/pr/86\""
bash workdir:~/project background:true command:"codex exec \"Review PR #87. git diff origin/main...origin/pr/87\""
bash workdir:~/project background:true command:"codex exec \"Review PR #95. git diff origin/main...origin/pr/95\""
# ... repeat for all PRs

# Monitor all
process action:list

# Get results and post to GitHub
process action:log sessionId:XXX
gh pr comment <PR#> --body "<review content>"
```

### Tips for PR Reviews
- **Fetch refs first:** `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`
- **Use git diff:** Tell Codex to use `git diff origin/main...origin/pr/XX`
- **Don't checkout:** Multiple parallel reviews = don't let them change branches
- **Post results:** Use `gh pr comment` to post reviews to GitHub

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
6. **Parallel is OK** — run many Codex processes at once for batch work
7. **NEVER start Codex in ~/clawd/** — it'll read your soul docs and get weird ideas about the org chart! Use the target project dir or /tmp for blank slate chats
