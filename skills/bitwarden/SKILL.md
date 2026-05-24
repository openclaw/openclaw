---
name: bitwarden
description: "Set up and use Bitwarden CLI for sign-in, desktop integration, and reading or injecting secrets."
homepage: https://bitwarden.com/help/cli/
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["bw"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@bitwarden/cli",
              "bins": ["bw"],
              "label": "Install Bitwarden CLI (npm)",
            },
            {
              "id": "brew",
              "kind": "brew",
              "formula": "bitwarden-cli",
              "cask": false,
              "bins": ["bw"],
              "label": "Install Bitwarden CLI (brew)",
            },
          ],
      },
  }
---

# Bitwarden CLI

Follow the official CLI get-started steps. Don't guess install commands.

## References

- `references/get-started.md` (install + app integration + sign-in flow)
- `references/cli-examples.md` (real `bw` examples)

## Workflow

1. Check OS + shell.
2. Verify CLI present: `bw --version`.
3. Confirm desktop app integration is enabled and the app is unlocked.
4. REQUIRED: create a fresh tmux session for all `bw` commands (no direct `bw` calls outside tmux).
5. Log in / authorize inside tmux: `bw login` (expect app prompt or master password).
6. Verify access inside tmux: `bw status` (must succeed before any secret read).
7. If multiple accounts: use `--session` or `BW_SESSION`.

## REQUIRED tmux session (tmux)

The shell tool uses a fresh TTY per command. To avoid re-prompts and failures, always run `bw` inside a dedicated tmux session with a fresh socket/session name.

Example (see `tmux` skill for socket conventions, do not reuse old session names):

```bash
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/openclaw-bw.sock"
SESSION="bw-auth-$(date +%Y%m%d-%H%M%S)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "bw login" Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "bw status" Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "bw list items" Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200
tmux -S "$SOCKET" kill-session -t "$SESSION"
```

## Guardrails

- Never paste secrets into logs, chat, or code.
- Prefer `bw get password` / `bw get notes` over writing secrets to disk.
- If login without app integration is needed, use `bw login --apikey`.
- If a command returns "not logged in", re-run `bw login` inside tmux and authorize.
- Do not run `bw` outside tmux; stop and ask if tmux is unavailable.
