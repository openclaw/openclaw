---
name: 1password
description: Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets.
homepage: https://developer.1password.com/docs/cli/get-started/
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires": { "bins": ["op"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "1password-cli",
              "bins": ["op"],
              "label": "Install 1Password CLI (brew)",
            },
          ],
      },
  }
---

# 1Password CLI

Follow the official CLI get-started steps. Don't guess install commands.

## References

- `references/get-started.md` (install + app integration + sign-in flow)
- `references/cli-examples.md` (real `op` examples)

## Workflow

1. Check OS + shell.
2. Verify CLI present: `op --version`.
3. Detect the auth mode the user has set up:
   - **Service account:** `OP_SERVICE_ACCOUNT_TOKEN` is set (typical for headless setups, CI, gateways).
   - **Desktop app integration:** the 1Password desktop app is running with CLI integration enabled (typical on macOS / Windows / Linux desktops).
   - **Standalone signin:** neither of the above — `op signin` will prompt for an account password every session.
4. Run `op` according to the auth mode (see below).
5. Verify access: `op whoami` should succeed before any secret read.
6. If multiple accounts: use `--account` or `OP_ACCOUNT`.

## Running `op` per auth mode

### Service account (preferred for headless / gateway use)

Direct exec. No tmux, no signin step.

```bash
export OP_SERVICE_ACCOUNT_TOKEN="ops_..."
op vault list
op read op://app-prod/db/password
```

### Desktop app integration

Direct exec. **Do not wrap in tmux** — the desktop app communicates with the CLI over a per-user Unix domain socket (on macOS:
`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/`) that is reliably reachable from the gateway's exec environment but not from arbitrary tmux subshells, which run with a different environment context.

```bash
op vault list      # may trigger Touch ID / Windows Hello / system auth on first call
op whoami
```

If a call returns `1Password CLI couldn't connect to the 1Password desktop app`, do not switch to tmux. Confirm the desktop app is running and unlocked, then retry direct exec.

### Standalone signin (no app, interactive password)

This is the only mode where tmux helps. `op signin` prints an `eval`-style export that authenticates subsequent commands in the same shell; the gateway's per-command shells lose that state, so a persistent tmux pane keeps the session token alive across calls.

```bash
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/openclaw-op.sock"
SESSION="op-auth-$(date +%Y%m%d-%H%M%S)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op signin --account my.1password.com" Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op whoami" Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "op vault list" Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200
tmux -S "$SOCKET" kill-session -t "$SESSION"
```

See the `tmux` skill for socket conventions; do not reuse old session names.

## Guardrails

- Never paste secrets into logs, chat, or code.
- Prefer `op run` / `op inject` over writing secrets to disk.
- If sign-in without app integration is needed, use `op account add` first.
- If a command returns "account is not signed in":
  - service account: re-export `OP_SERVICE_ACCOUNT_TOKEN`
  - desktop app: confirm the app is running and integration is enabled
  - standalone: re-run `op signin` inside the same tmux session and authorize
