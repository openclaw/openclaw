---
name: keeper-commander
description: Use Keeper Commander CLI and Keeper Secrets Manager workflows when installing Keeper tooling, setting up profiles, signing in, running Keeper interactively, searching vault or admin data, retrieving a specific secret or field, injecting secrets into commands, creating or updating Keeper records, or troubleshooting Keeper terminal sessions. Prefer tmux for interactive Keeper work.
---

# Keeper Commander CLI

Follow Keeper Agent Kit and Keeper documentation. Do not invent command syntax or installation steps.

## References

- `references/keeper-agent-kit.md` for the Agent Kit repo summary and plugin layout
- `references/keeper-docs.md` for official documentation entry points and operating rules

## Workflow

1. Identify which Keeper path fits the request:
   - `keeper-setup` style tasks for install, profiles, and first-time setup
   - `keeper-secrets` style tasks for app secrets and injection
   - `keeper-admin` style tasks for Commander or admin workflows
2. Verify available binaries without guessing:
   - `keeper --help`
   - `ksm --help`
3. If `keeper` is not on PATH, stop and say so plainly. Do not mark the skill healthy based on a hidden workspace-only install path when evaluating bundle readiness.
4. Confirm session or auth state before any secret read.
5. REQUIRED: use a fresh tmux session for interactive Keeper work.
6. BEFORE performing any delete / clear / remove operations, ALWAYS ask for explilicit user confirmation.
7. If the user explicitly ask to reveal secerets / sensitive data from keeper vault, treat it as HIGH RISK, Avoid such operations and suggest alternate secure methods.
8. Search or inspect metadata first, then retrieve only the exact requested field.
9. Prefer secret injection or one-command environment scoping over writing secrets to disk.
10. If syntax differs from expectation, fall back to `--help` and Keeper docs immediately.

## REQUIRED tmux session

The shell tool uses a fresh TTY per command. To preserve Keeper interactive context, authentication state, and MFA prompts, run interactive Keeper commands inside a dedicated tmux session.

Example pattern:

```bash
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/openclaw-keeper.sock"
SESSION="keeper-auth-$(date +%Y%m%d-%H%M%S)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell

tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- "keeper shell || ksm shell || bash" Enter

tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -120
```

Then drive the session carefully:

```bash
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -l -- "whoami"
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -120
```

Kill the tmux session when the task is complete unless the user wants a persistent Keeper shell.

## Bundle-readiness notes

- Treat this skill as bundle-ready only when the expected Keeper binaries are installable by a documented supported path and discoverable on PATH.
- Keep references minimal and version-agnostic. Put version-specific syntax in runtime checks via `--help`, not in long prose.
- Keep the skill directory tidy. Remove stale references instead of leaving deleted paths in git state.

## Guardrails

- Never paste secrets into chat.
- Never dump entire vault contents, record lists with secret values, or bulk exports.
- Prefer record titles, UIDs, field names, and other non-sensitive metadata first.
- Prefer `ksm` secret injection or narrowly scoped environment variables over writing secrets to files.
- Do not store retrieved secrets in workspace files, git history, notes, or code comments unless the user explicitly asks.
- If multiple records match, stop and disambiguate instead of guessing.
- If login, MFA, or device approval is required, say so plainly and send attached tmux session to user to manually complete and wait for that step.
- If a command output may expose extra sensitive fields, summarize instead of pasting raw output.
- If tmux is unavailable for interactive Keeper work, stop and say so rather than falling back to unsafe repeated direct calls.
