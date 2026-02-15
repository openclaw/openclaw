---
name: tmux
description: Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.
---

# tmux Session Control

Control tmux sessions by sending keystrokes and reading output. Essential for managing Claude Code sessions.

## When to Use

✅ **USE this skill when:**
- Monitoring Claude Code sessions (shared, claude2-8)
- Sending input to interactive terminal applications
- Scraping output from long-running processes in tmux
- Navigating tmux panes/windows programmatically
- Checking on background work in existing sessions

## When NOT to Use

❌ **DON'T use this skill when:**
- Running one-off shell commands → use `exec` tool directly
- Starting new background processes → use `exec` with `background:true`
- Non-interactive scripts → use `exec` tool
- The process isn't in tmux
- You need to create a new tmux session → use `exec` with `tmux new-session`

## Blake's tmux Sessions

| Session | Purpose |
|---------|---------|
| `shared` | Primary Claude Code session (Blake watches via `tmux attach -t shared`) |
| `claude2` - `claude8` | Parallel Claude Code workers |

## Common Commands

### List Sessions
```bash
tmux list-sessions
tmux ls
```

### Capture Output
```bash
# Last 20 lines of pane
tmux capture-pane -t shared -p | tail -20

# Entire scrollback
tmux capture-pane -t shared -p -S -

# Specific pane in window
tmux capture-pane -t shared:0.0 -p
```

### Send Keys
```bash
# Send text (doesn't press Enter)
tmux send-keys -t shared "hello"

# Send text + Enter
tmux send-keys -t shared "y" Enter

# Send special keys
tmux send-keys -t shared Enter
tmux send-keys -t shared Escape
tmux send-keys -t shared C-c          # Ctrl+C
tmux send-keys -t shared C-d          # Ctrl+D (EOF)
tmux send-keys -t shared C-z          # Ctrl+Z (suspend)
```

### Window/Pane Navigation
```bash
# Select window
tmux select-window -t shared:0

# Select pane
tmux select-pane -t shared:0.1

# List windows
tmux list-windows -t shared
```

### Session Management
```bash
# Create new session
tmux new-session -d -s newsession

# Kill session
tmux kill-session -t sessionname

# Rename session
tmux rename-session -t old new
```

## Claude Code Session Patterns

### Check if Session Needs Input
```bash
# Look for prompts
tmux capture-pane -t claude3 -p | tail -10 | grep -E "❯|Yes.*No|proceed|permission"
```

### Approve Claude Code Prompt
```bash
# Send 'y' and Enter
tmux send-keys -t claude3 'y' Enter

# Or select numbered option
tmux send-keys -t claude3 '2' Enter
```

### Check All Sessions Status
```bash
for s in shared claude2 claude3 claude4 claude5 claude6 claude7 claude8; do
  echo "=== $s ==="
  tmux capture-pane -t $s -p 2>/dev/null | tail -5
done
```

### Send Task to Session
```bash
tmux send-keys -t claude4 "Fix the bug in auth.js" Enter
```

## Notes

- Use `capture-pane -p` to print to stdout (essential for scripting)
- `-S -` captures entire scrollback history
- Target format: `session:window.pane` (e.g., `shared:0.0`)
- Sessions persist across SSH disconnects
