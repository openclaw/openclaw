---
summary: "Repository scripts: purpose, scope, and safety notes"
read_when:
  - Running scripts from the repo
  - Adding or changing scripts under ./scripts
title: "Scripts"
---

`scripts/` holds helper scripts for local workflows and ops tasks. Use these when a task is clearly tied to a script. Otherwise prefer the CLI.

## Conventions

- Scripts are **optional** unless referenced in docs or release checklists.
- Prefer CLI surfaces when they exist (example: `openclaw models status --check`).
- Assume scripts are host-specific. Read them before running on a new machine.

## Auth monitoring scripts

General model auth is covered in [Authentication](/gateway/authentication). The scripts below are a separate, optional system. They consume `openclaw models status --json` through the status helper to monitor Claude CLI login readiness and OpenClaw-managed authentication on a remote/headless host. They do not read Claude CLI credentials or monitor native token expiry; the Claude process owns refresh.

- `scripts/setup-auth-system.sh` - one-time setup: checks current auth, helps generate a long-lived `claude setup-token`, and installs the systemd timer. Run it from a shell where `openclaw` and `node` are available: it records their executable directories and the current `PATH` in the service environment so user-local installs work under systemd. Re-run setup after moving either executable. It also prints Termux install steps.
- `scripts/claude-auth-status.sh [full|json|simple]` - reports native Claude CLI readiness and OpenClaw-managed auth status. Configured or unknown native readiness is not an expired login. If status cannot be fetched, simple mode returns `UNKNOWN` with exit code `3`, without requesting login.
- `scripts/auth-monitor.sh` - sends a notification (via `openclaw message send`, and/or ntfy.sh) for a definitely missing native login, using the runtime owner's recovery message, or missing/expired OpenClaw-managed credentials. It also warns before managed credentials expire, including their final hour while authentication remains usable. Native configured/unknown readiness never triggers an expiry alert. Env: `WARN_HOURS` (default `2`, managed credentials only), `NOTIFY_PHONE`, `NOTIFY_NTFY`. Failed delivery does not start the one-hour cooldown. Run on a schedule via the bundled `scripts/systemd/openclaw-auth-monitor.{service,timer}` (every 30 minutes).
- `scripts/mobile-reauth.sh` - re-runs `claude setup-token` and prints URLs to open on a phone, for use over SSH from Termux.
- `scripts/termux-quick-auth.sh`, `scripts/termux-auth-widget.sh` - Termux:Widget scripts. They SSH to the host and show a status toast. They open the re-auth console/instructions when auth has expired; `UNKNOWN` only shows an unavailable-status message. `scripts/mobile-reauth.sh` also stops without requesting login when status is unavailable.

For a manually configured cron job, set `PATH` in the crontab to include both the `openclaw` and `node` executable directories, plus the standard system utilities. Cron does not inherit your interactive shell's `PATH`; without those entries, the helper returns `UNKNOWN` rather than reading credential files or requesting login.

To use a Claude CLI login with OpenClaw, follow [Claude CLI reuse](/gateway/authentication#anthropic-claude-cli-reuse). The Claude process owns its login credentials.

## GitHub read helper

Use `scripts/gh-read` when you want `gh` to use a GitHub App installation token for repo-scoped read calls. This leaves normal `gh` on your personal login for write actions.

Required env:

- `OPENCLAW_GH_READ_APP_ID`
- `OPENCLAW_GH_READ_PRIVATE_KEY_FILE`

Optional env:

- `OPENCLAW_GH_READ_INSTALLATION_ID` when you want to skip repo-based installation lookup
- `OPENCLAW_GH_READ_PERMISSIONS` as a comma-separated override for the read permission subset to request

Repo resolution order:

- `gh ... -R owner/repo`
- `GH_REPO`
- `git remote origin`

Examples:

- `scripts/gh-read pr view 123`
- `scripts/gh-read run list -R openclaw/openclaw`
- `scripts/gh-read api repos/openclaw/openclaw/pulls/123`

## When adding scripts

- Keep scripts focused and documented.
- Add a short entry in the relevant doc (or create one if missing).

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
