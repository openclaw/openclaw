---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How the macOS app reports gateway/Baileys health states"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging mac app health indicators（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Health Checks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Health Checks on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
How to see whether the linked channel is healthy from the menu bar app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Menu bar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status dot now reflects Baileys health:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Green: linked + socket opened recently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Orange: connecting/retrying.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Red: logged out or probe failed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Secondary line reads "linked · auth 12m" or shows the failure reason.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- "Run Health Check" menu item triggers an on-demand probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- General tab gains a Health card showing: linked auth age, session-store path/count, last check time, last error/status code, and buttons for Run Health Check / Reveal Logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses a cached snapshot so the UI loads instantly and falls back gracefully when offline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Channels tab** surfaces channel status + controls for WhatsApp/Telegram (login QR, logout, probe, last disconnect/error).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How the probe works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- App runs `openclaw health --json` via `ShellExecutor` every ~60s and on demand. The probe loads creds and reports status without sending messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cache the last good snapshot and the last error separately to avoid flicker; show the timestamp of each.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When in doubt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can still use the CLI flow in [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) and tail `/tmp/openclaw/openclaw-*.log` for `web-heartbeat` / `web-reconnect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
