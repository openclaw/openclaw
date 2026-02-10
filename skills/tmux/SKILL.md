---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: tmux（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { "openclaw": { "emoji": "🧵", "os": ["darwin", "linux"], "requires": { "bins": ["tmux"] } } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# tmux Skill (OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use tmux only when you need an interactive TTY. Prefer exec background mode for long-running, non-interactive tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quickstart (isolated socket, exec tool)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${CLAWDBOT_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p "$SOCKET_DIR"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SOCKET="$SOCKET_DIR/openclaw.sock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SESSION=openclaw-python（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After starting a session, always print monitor commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To monitor:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tmux -S "$SOCKET" attach -t "$SESSION"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Socket convention（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `OPENCLAW_TMUX_SOCKET_DIR` (legacy `CLAWDBOT_TMUX_SOCKET_DIR` also supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default socket path: `"$OPENCLAW_TMUX_SOCKET_DIR/openclaw.sock"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Targeting panes and naming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Target format: `session:window.pane` (defaults to `:0.0`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep names short; avoid spaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inspect: `tmux -S "$SOCKET" list-sessions`, `tmux -S "$SOCKET" list-panes -a`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Finding sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List sessions on your socket: `{baseDir}/scripts/find-sessions.sh -S "$SOCKET"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scan all sockets: `{baseDir}/scripts/find-sessions.sh --all` (uses `OPENCLAW_TMUX_SOCKET_DIR`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sending input safely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer literal sends: `tmux -S "$SOCKET" send-keys -t target -l -- "$cmd"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control keys: `tmux -S "$SOCKET" send-keys -t target C-c`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For interactive TUI apps like Claude Code/Codex, this guidance covers **how to send commands**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Do **not** append `Enter` in the same `send-keys`. These apps may treat a fast text+Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sequence as paste/multi-line input and not submit; this is timing-dependent. Send text and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `Enter` as separate commands with a small delay (tune per environment; increase if needed,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  or use `sleep 1` if sub-second sleeps aren't supported):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t target -l -- "$cmd" && sleep 0.1 && tmux -S "$SOCKET" send-keys -t target Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Watching output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capture recent history: `tmux -S "$SOCKET" capture-pane -p -J -t target -S -200`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wait for prompts: `{baseDir}/scripts/wait-for-text.sh -t session:0.0 -p 'pattern'`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attaching is OK; detach with `Ctrl+b d`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Spawning processes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For python REPLs, set `PYTHON_BASIC_REPL=1` (non-basic REPL breaks send-keys flows).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Windows / WSL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- tmux is supported on macOS/Linux. On Windows, use WSL and install tmux inside WSL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This skill is gated to `darwin`/`linux` and requires `tmux` on PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Orchestrating Coding Agents (Codex, Claude Code)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux excels at running multiple coding agents in parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SOCKET="${TMPDIR:-/tmp}/codex-army.sock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Create multiple sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for i in 1 2 3 4 5; do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tmux -S "$SOCKET" new-session -d -s "agent-$i"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
done（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Launch agents in different workdirs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t agent-1 "cd /tmp/project1 && codex --yolo 'Fix bug X'" Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t agent-2 "cd /tmp/project2 && codex --yolo 'Fix bug Y'" Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# When sending prompts to Claude Code/Codex TUI, split text + Enter with a delay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t agent-1 -l -- "Please make a small edit to README.md." && sleep 0.1 && tmux -S "$SOCKET" send-keys -t agent-1 Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Poll for completion (check if prompt returned)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for sess in agent-1 agent-2; do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if tmux -S "$SOCKET" capture-pane -p -t "$sess" -S -3 | grep -q "❯"; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    echo "$sess: DONE"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    echo "$sess: Running..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
done（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Get full output from completed session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" capture-pane -p -t agent-1 -S -500（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Tips:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use separate git worktrees for parallel fixes (no branch conflicts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm install` first before running codex in fresh clones（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check for shell prompt (`❯` or `$`) to detect completion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Codex needs `--yolo` or `--full-auto` for non-interactive fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cleanup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Kill a session: `tmux -S "$SOCKET" kill-session -t "$SESSION"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Kill all sessions on a socket: `tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remove everything on the private socket: `tmux -S "$SOCKET" kill-server`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Helper: wait-for-text.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`{baseDir}/scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/scripts/wait-for-text.sh -t session:0.0 -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-t`/`--target` pane target (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-T` timeout seconds (integer, default 15)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-i` poll interval seconds (default 0.5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-l` history lines to search (integer, default 1000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
