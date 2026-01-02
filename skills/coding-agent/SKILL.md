---
name: coding-agent
description: Run Claude Code, Codex CLI, or OpenCode via tmux for resilient coding sessions.
metadata: {"clawdis":{"emoji":"🧩","requires":{"bins":["tmux"],"anyBins":["claude","codex","opencode"]}}}
---

# Coding Agent (tmux-first)

Use **tmux** for all coding-agent CLIs. Keep sessions resumable and logs visible.

## Quick preflight

```bash
command -v claude codex opencode tmux
```

If none of `claude`, `codex`, `opencode` exist, stop and ask to install.

## tmux baseline

```bash
# Create or attach
tmux new -A -s coding-agent

# Split panes
tmux split-window -h
tmux split-window -v

# Leave running, detach
tmux detach
```

## Claude Code

Interactive (preferred in tmux):
- `claude` — start session
- `claude -c` — continue most recent
- `claude -r ""` — picker
- `claude -r <session_id>` — resume specific

## Codex CLI

⚠️ **Use gpt-5.2-codex with medium reasoning!**

**One-shot with tmux (recommended):**
```bash
# IMPORTANT: Use bash workdir param to start in the target folder!
# This way Codex "wakes up in a little box" - only sees relevant files

# Start Codex in target directory
bash workdir:~/project/folder command:"tmux new -d -s codex-task 'codex exec --model gpt-5.2-codex -c reasoning_effort=\"medium\" -s workspace-write \"Your task\"'"

# Monitor progress
tmux capture-pane -t codex-task -p | tail -20
```

**Interactive:**
- `codex "Your prompt"`
- `codex resume`
- `codex resume --last`
- `codex resume --session <id>`

**Apply changes:**
- `codex apply`

**Useful flags:**
- `-s workspace-write` — Allow writing to workspace
- `--full-auto` — Sandboxed + auto-approve
- `-C <dir>` — Set working directory
- `--skip-git-repo-check` — Run outside git repos

## OpenCode

One-shot:
- `opencode run "Your task"`
- `opencode run -m anthropic/claude-sonnet-4-5 "Complex task"`

Interactive:
- `opencode`
- `opencode -c`
- `opencode -s <session-id>`

## Notes

- **Always prefer tmux** — keeps history, survives disconnects, allows monitoring
- For auth: `claude`, `codex login`, `opencode auth`
- Check tmux session: `tmux attach -t <session-name>`
- List sessions: `tmux list-sessions`

## ⚠️ IMPORTANT: Respect Tool Choice!

**If user asks for Codex/Claude Code/OpenCode → USE THAT TOOL!**
- NEVER offer to "just build it yourself" instead
- NEVER kill a running session because it's "too slow"
- Let the tool complete its work — be patient!
- The user wants to test/use that specific tool for a reason
