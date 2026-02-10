---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: 1password（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Set up and use 1Password CLI (op). Use when installing the CLI, enabling desktop app integration, signing in (single or multi-account), or reading/injecting/running secrets via op.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://developer.1password.com/docs/cli/get-started/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🔐",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["op"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "1password-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["op"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install 1Password CLI (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 1Password CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Follow the official CLI get-started steps. Don't guess install commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `references/get-started.md` (install + app integration + sign-in flow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `references/cli-examples.md` (real `op` examples)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check OS + shell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Verify CLI present: `op --version`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Confirm desktop app integration is enabled (per get-started) and the app is unlocked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. REQUIRED: create a fresh tmux session for all `op` commands (no direct `op` calls outside tmux).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Sign in / authorize inside tmux: `op signin` (expect app prompt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Verify access inside tmux: `op whoami` (must succeed before any secret read).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. If multiple accounts: use `--account` or `OP_ACCOUNT`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## REQUIRED tmux session (T-Max)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The shell tool uses a fresh TTY per command. To avoid re-prompts and failures, always run `op` inside a dedicated tmux session with a fresh socket/session name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (see `tmux` skill for socket conventions, do not reuse old session names):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${CLAWDBOT_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p "$SOCKET_DIR"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SOCKET="$SOCKET_DIR/openclaw-op.sock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SESSION="op-auth-$(date +%Y%m%d-%H%M%S)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op signin --account my.1password.com" Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op whoami" Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op vault list" Enter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tmux -S "$SOCKET" kill-session -t "$SESSION"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Guardrails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never paste secrets into logs, chat, or code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `op run` / `op inject` over writing secrets to disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If sign-in without app integration is needed, use `op account add`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a command returns "account is not signed in", re-run `op signin` inside tmux and authorize in the app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `op` outside tmux; stop and ask if tmux is unavailable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
