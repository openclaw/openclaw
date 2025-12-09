# Health Checks on macOS

How to see whether the WhatsApp Web/Baileys bridge is healthy from the menu bar app.

## Menu bar
- Status dot now reflects Baileys health:
  - Green: linked + socket opened recently.
  - Orange: connecting/retrying.
  - Red: logged out or probe failed.
- Secondary line reads "Web: linked · auth 12m · socket ok" or shows the failure reason.
- "Run Health Check" menu item triggers an on-demand probe.

## Settings
- General tab gains a Health card showing: linked auth age, session-store path/count, last check time, last error/status code, and buttons for Run Health Check / Reveal Logs.
- Uses a cached snapshot so the UI loads instantly and falls back gracefully when offline.

## How the probe works
- App runs `clawdis health --json` via `ShellExecutor` every ~60s and on demand. The probe loads creds, attempts a short Baileys connect, and reports status without sending messages.
- Cache the last good snapshot and the last error separately to avoid flicker; show the timestamp of each.

## When in doubt
- You can still use the CLI flow in `docs/health.md` (status, heartbeat dry-run, relay heartbeat) and tail `/tmp/clawdis/clawdis.log` for `web-heartbeat` / `web-reconnect`.
