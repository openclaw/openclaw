---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Health check steps for channel connectivity"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Diagnosing WhatsApp channel health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Health Checks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Health Checks (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short guide to verify channel connectivity without guessing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status` — local summary: gateway reachability/mode, update hint, linked channel auth age, sessions + recent activity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status --all` — full local diagnosis (read-only, color, safe to paste for debugging).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status --deep` — also probes the running Gateway (per-channel probes when supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw health --json` — asks the running Gateway for a full health snapshot (WS-only; no direct Baileys socket).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/status` as a standalone message in WhatsApp/WebChat to get a status reply without invoking the agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logs: tail `/tmp/openclaw/openclaw-*.log` and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Deep diagnostics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Creds on disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime should be recent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session store: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Note: the QR login flow auto-restarts once for status 515 after pairing.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When something fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logged out` or status 409–515 → relink with `openclaw channels logout` then `openclaw channels login`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway unreachable → start it: `openclaw gateway --port 18789` (use `--force` if the port is busy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No inbound messages → confirm linked phone is online and the sender is allowed (`channels.whatsapp.allowFrom`); for group chats, ensure allowlist + mention rules match (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Dedicated "health" command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw health --json` asks the running Gateway for its health snapshot (no direct channel sockets from the CLI). It reports linked creds/auth age when available, per-channel probe summaries, session-store summary, and a probe duration. It exits non-zero if the Gateway is unreachable or the probe fails/timeouts. Use `--timeout <ms>` to override the 10s default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
