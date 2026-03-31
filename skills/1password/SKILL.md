---
name: 1password
description: Set up and use 1Password CLI (op). Use when installing the CLI, enabling desktop app integration, signing in (single or multi-account), or reading/injecting/running secrets via op.
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

## Quick Check: Docker Secrets vs Interactive Auth

First, check if a service account token is mounted via Docker secrets:

```bash
ls -la /var/run/secrets/OP_SERVICE_ACCOUNT_TOKEN
```

If this file exists, use the **Docker Secrets Pattern** below (simpler, no tmux needed).
If not, fall back to the **Interactive Auth Pattern** (requires tmux).

---

## Docker Secrets Pattern (Preferred)

When running in a container with a 1Password service account token mounted:

### 1. Set the token from the secret file

```bash
export OP_SERVICE_ACCOUNT_TOKEN=$(cat /var/run/secrets/OP_SERVICE_ACCOUNT_TOKEN)
```

### 2. Verify access

```bash
op whoami
op vault list
```

### 3. Use op directly

```bash
op item list --vault <vault-name>
op item get "<item-title>" --vault <vault-name>
op item get "<item-title>" --vault <vault-name> --fields label=password
```

**No tmux required.** The service account token handles auth automatically.

### Common Operations

```bash
# List all vaults
op vault list

# List items in a vault
op item list --vault Lexi

# Get full item details
op item get "linkedin.com" --vault Lexi

# Get specific field
op item get "linkedin.com" --vault Lexi --fields label=username
op item get "linkedin.com" --vault Lexi --fields label=password

# Get item as JSON for scripting
op item get "linkedin.com" --vault Lexi --format json
```

---

## Interactive Auth Pattern (Fallback)

For local machines or containers without Docker secrets, use interactive auth via tmux.

### 1. Check OS + shell

```bash
uname -a
echo $SHELL
```

### 2. Verify CLI present

```bash
op --version
```

### 3. Confirm desktop app integration

The 1Password desktop app must be running and unlocked. Integration must be enabled in the app settings.

### 4. REQUIRED: Use tmux for all op commands

The shell tool uses a fresh TTY per command. To avoid re-prompts and failures, always run `op` inside a dedicated tmux session.

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

### 5. If multiple accounts

Use `--account` flag or `OP_ACCOUNT` env var to specify which account.

---

## Guardrails

- Never paste secrets into logs, chat, or code.
- Prefer `op run` / `op inject` over writing secrets to disk.
- If sign-in without app integration is needed, use `op account add`.
- If a command returns "account is not signed in":
  - For Docker secrets: verify the secret file exists and contains a valid token
  - For interactive auth: re-run `op signin` inside tmux
- For interactive auth: do not run `op` outside tmux; stop and ask if tmux is unavailable.
