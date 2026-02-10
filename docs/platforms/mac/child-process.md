---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway lifecycle on macOS (launchd)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Integrating the mac app with the gateway lifecycle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway Lifecycle"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway lifecycle on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app **manages the Gateway via launchd** by default and does not spawn（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the Gateway as a child process. It first tries to attach to an already‑running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway on the configured port; if none is reachable, it enables the launchd（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
service via the external `openclaw` CLI (no embedded runtime). This gives you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
reliable auto‑start at login and restart on crashes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Child‑process mode (Gateway spawned directly by the app) is **not in use** today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need tighter coupling to the UI, run the Gateway manually in a terminal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Default behavior (launchd)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app installs a per‑user LaunchAgent labeled `bot.molt.gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` is supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When Local mode is enabled, the app ensures the LaunchAgent is loaded and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  starts the Gateway if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logs are written to the launchd gateway log path (visible in Debug Settings).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl kickstart -k gui/$UID/bot.molt.gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl bootout gui/$UID/bot.molt.gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replace the label with `bot.molt.<profile>` when running a named profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Unsigned dev builds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`scripts/restart-mac.sh --no-sign` is for fast local builds when you don’t have（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
signing keys. To prevent launchd from pointing at an unsigned relay binary, it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes `~/.openclaw/disable-launchagent`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Signed runs of `scripts/restart-mac.sh` clear this override if the marker is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
present. To reset manually:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rm ~/.openclaw/disable-launchagent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Attach-only mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To force the macOS app to **never install or manage launchd**, launch it with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--attach-only` (or `--no-launchd`). This sets `~/.openclaw/disable-launchagent`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
so the app only attaches to an already running Gateway. You can toggle the same（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
behavior in Debug Settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote mode never starts a local Gateway. The app uses an SSH tunnel to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remote host and connects over that tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why we prefer launchd（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto‑start at login.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Built‑in restart/KeepAlive semantics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Predictable logs and supervision.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a true child‑process mode is ever needed again, it should be documented as a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
separate, explicit dev‑only mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
