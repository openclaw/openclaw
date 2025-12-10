---
summary: "Health check steps for Baileys/WhatsApp connectivity"
read_when:
  - Diagnosing web provider health
---
# Health Checks (CLI)

Short guide to verify the WhatsApp Web / Baileys stack without guessing.

## Quick checks
- `pnpm clawdis status --json` — via the gateway; confirms creds exist (`web.linked`), shows auth age (`authAgeMs`), heartbeat interval, and where the session store lives.
- Send `/status` in WhatsApp/WebChat to see agent readiness, session context usage, current thinking/verbose options, and when the web creds were last refreshed (relink if it looks stale) without invoking the agent.
- `pnpm clawdis heartbeat --verbose --dry-run` — runs the heartbeat path end-to-end (session resolution, message creation) without sending anything. Drop `--dry-run` or add `--message "Ping"` to actually send.
- `pnpm clawdis gateway --verbose --heartbeat-now` — spins the full monitor loop, fires a heartbeat immediately, and will reconnect per `web.reconnect` settings. Good for soak testing.
- Logs: tail `/tmp/clawdis/clawdis.log` and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Deep diagnostics
- Creds on disk: `ls -l ~/.clawdis/credentials/creds.json` (mtime should be recent).
- Session store: `ls -l ~/.clawdis/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.
- Relink flow: `pnpm clawdis logout && pnpm clawdis login --provider web --verbose` when status codes 409–515 or `loggedOut` appear in logs.

## When something fails
- `logged out` or status 409–515 → relink with `clawdis logout` then `clawdis login --provider web`.
- Repeated reconnect exits → tune `web.reconnect` (flags: `--web-retries`, `--web-retry-initial`, `--web-retry-max`) and rerun gateway.
- No inbound messages → confirm linked phone is online and sender is allowed; use `pnpm clawdis heartbeat --all --verbose` to test each known recipient.

## Dedicated "health" command
`pnpm clawdis health --json` asks the running gateway for its health snapshot (no direct Baileys socket from the CLI). It reports linked creds, auth age, Baileys connect result/status code, session-store summary, and a probe duration. It exits non-zero if not linked or if the gateway probe fails/timeouts. Use `--timeout <ms>` to override the 10s default.
