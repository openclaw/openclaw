---
name: tmux
description: Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.
metadata:
  { "openclaw": { "emoji": "🧵", "os": ["darwin", "linux"], "requires": { "bins": ["tmux"] } } }
---

# tmux Session Control

Control tmux sessions by sending keystrokes and reading output. Essential for managing Claude Code sessions.

## When to Use

✅ **USE this skill when:**

- Monitoring Claude/Codex sessions in tmux
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

## Example Sessions

| Session                 | Purpose                     |
| ----------------------- | --------------------------- |
| `shared`                | Primary interactive session |
| `worker-2` - `worker-8` | Parallel worker sessions    |

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

## Sending Input Safely

For interactive TUIs (Claude Code, Codex, etc.), split text and Enter into separate sends to avoid paste/multiline edge cases:

```bash
tmux send-keys -t shared -l -- "Please apply the patch in src/foo.ts"
sleep 0.1
tmux send-keys -t shared Enter
```

## Claude Code Session Patterns

### Check if Session Needs Input

```bash
# Look for prompts
tmux capture-pane -t worker-3 -p | tail -10 | grep -E "❯|Yes.*No|proceed|permission"
```

### Approve Claude Code Prompt

```bash
# Send 'y' and Enter
tmux send-keys -t worker-3 'y' Enter

# Or select numbered option
tmux send-keys -t worker-3 '2' Enter
```

### Check All Sessions Status

```bash
for s in shared worker-2 worker-3 worker-4 worker-5 worker-6 worker-7 worker-8; do
  echo "=== $s ==="
  tmux capture-pane -t $s -p 2>/dev/null | tail -5
done
```

### Send Task to Session

```bash
tmux send-keys -t worker-4 "Fix the bug in auth.js" Enter
```

## Long-Running Coding Agent Workflow

For coding tasks that may take minutes (Claude Code, Codex, Aider), use this pattern:

### Step 1: Setup and launch

```bash
# Kill stale session if exists, create fresh one
tmux kill-session -t claude-work 2>/dev/null
tmux new-session -d -s claude-work
tmux send-keys -t claude-work "cd /path/to/project && git pull" Enter
sleep 2
tmux send-keys -t claude-work "claude --dangerously-skip-permissions 'your task here'" Enter
```

### Step 2: Handle permission prompts

Claude Code may show a bypass prompt on startup:

```bash
# Wait for prompt to appear, then accept
sleep 5
tmux send-keys -t claude-work Down Enter
```

### Step 3: Monitor progress

```bash
# Check current state (last 80 lines with scrollback)
tmux capture-pane -t claude-work -p -S -200 | tail -80

# Look for completion
tmux capture-pane -t claude-work -p | grep -E "Done|✓|committed|pushed"
```

### Step 4: Interrupt if stuck

If the coding agent stalls (no token progress for 2+ minutes):

```bash
# Send Ctrl+C to interrupt
tmux send-keys -t claude-work C-c
sleep 3
# Give a simpler instruction
tmux send-keys -t claude-work "Use bash commands directly to complete the task" Enter
```

### Step 5: Chain follow-up tasks

After one task completes, send the next without creating a new session:

```bash
tmux send-keys -t claude-work "Now create tests for the feature you just built" Enter
```

## Batch Script Execution

For repetitive tasks, write a shell script and run it in tmux:

```bash
tmux new-session -d -s batch
tmux send-keys -t batch "bash /path/to/batch-script.sh" Enter

# Monitor progress
tmux capture-pane -t batch -p | grep "=== .* DONE ==="
```

## Notes

- Use `capture-pane -p` to print to stdout (essential for scripting)
- `-S -` captures entire scrollback history (use `-S -200` for last ~200 lines)
- Target format: `session:window.pane` (e.g., `shared:0.0`)
- Sessions persist across SSH disconnects
- Always `kill-session` before `new-session` to avoid "duplicate session" errors
- Use `sleep` between commands to avoid input buffering issues
