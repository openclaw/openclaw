---
name: 1password
description: Use 1Password CLI for service-account token auth, interactive sign-in fallback, and reading, writing, injecting, or running secrets with op.
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

Prefer non-interactive service-account token auth when an `OP_SERVICE_ACCOUNT_TOKEN` or token file is available. Use desktop app integration and `op signin` only for explicit interactive setups.

## References

- `references/get-started.md` (install + app integration + sign-in flow)
- `references/cli-examples.md` (real `op` examples)

## Workflow

1. Check OS + shell.
2. Verify CLI present: `op --version`.
3. If service-account auth is available, set `OP_SERVICE_ACCOUNT_TOKEN` for the command and verify with `op whoami`.
4. If no service-account token is available and the user wants interactive auth, follow the desktop app integration/sign-in flow in `references/get-started.md`.
5. Verify access before secret reads: `op whoami`; use `op vault list --format json` when vault access needs checking.
6. Wrap networked `op` calls with a timeout (`gtimeout 15` on macOS when available, otherwise `timeout 15`) and retry once on timeout.
7. Use `op item get`, `op read`, `op item create`, `op item edit`, `op run`, or `op inject`.

```bash
TOKEN_FILE="${OP_SERVICE_ACCOUNT_TOKEN_FILE:-$HOME/.op-service-token}"
if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  op whoami
elif [[ -f "$TOKEN_FILE" ]]; then
  OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")" op whoami
else
  op signin
fi
```

## Service Account Examples

```bash
TOKEN_FILE="${OP_SERVICE_ACCOUNT_TOKEN_FILE:-$HOME/.op-service-token}"
OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")" \
  op vault list --format json
```

```bash
TOKEN_FILE="${OP_SERVICE_ACCOUNT_TOKEN_FILE:-$HOME/.op-service-token}"
OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")" \
  op item get "Item Name" --vault "Vault Name" --fields credential --reveal
```

## Interactive Auth Fallback

Use this only when service-account auth is unavailable and the user expects an interactive/manual setup.

```bash
op signin
op whoami
op vault list
```

If a fresh TTY is required, run `op signin` in a dedicated terminal or tmux session, then run dependent `op` commands in the same authenticated shell.

## Troubleshooting

- If `op` hangs, inspect stale CLI state before declaring a token bad: check for stuck `op`/`op daemon` processes and remove `~/.config/op/op-daemon.sock` when safe.
- Validate token auth with the canonical CLI path: `OP_SERVICE_ACCOUNT_TOKEN=... op whoami`.
- Do not infer token validity from arbitrary 1Password HTTP endpoints; some return 401/403/HTML for valid setups.
- If the token file is missing, ask where the service-account token is stored rather than guessing or copying secrets.

## Guardrails

- Never paste secrets into logs, chat, or code.
- Never print `OP_SERVICE_ACCOUNT_TOKEN`; redact command output if it may contain it.
- Prefer `op run` / `op inject` over writing secrets to disk.
- Store new credentials in the intended vault before use whenever possible.
- Do not use `op account add` or desktop auth unless the user requested interactive account setup.
