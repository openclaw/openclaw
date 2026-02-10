---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "PeekabooBridge integration for macOS UI automation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Hosting PeekabooBridge in OpenClaw.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Integrating Peekaboo via Swift Package Manager（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing PeekabooBridge protocol/paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Peekaboo Bridge"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Peekaboo Bridge (macOS UI automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can host **PeekabooBridge** as a local, permission‑aware UI automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
broker. This lets the `peekaboo` CLI drive UI automation while reusing the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS app’s TCC permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What this is (and isn’t)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Host**: OpenClaw.app can act as a PeekabooBridge host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Client**: use the `peekaboo` CLI (no separate `openclaw ui ...` surface).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **UI**: visual overlays stay in Peekaboo.app; OpenClaw is a thin broker host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable the bridge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In the macOS app:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settings → **Enable Peekaboo Bridge**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, OpenClaw starts a local UNIX socket server. If disabled, the host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is stopped and `peekaboo` will fall back to other available hosts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Client discovery order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Peekaboo clients typically try hosts in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Peekaboo.app (full UX)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Claude.app (if installed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. OpenClaw.app (thin broker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `peekaboo bridge status --verbose` to see which host is active and which（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
socket path is in use. You can override with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security & permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The bridge validates **caller code signatures**; an allowlist of TeamIDs is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  enforced (Peekaboo host TeamID + OpenClaw app TeamID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requests time out after ~10 seconds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If required permissions are missing, the bridge returns a clear error message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  rather than launching System Settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Snapshot behavior (automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Snapshots are stored in memory and expire automatically after a short window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need longer retention, re‑capture from the client.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `peekaboo` reports “bridge client is not authorized”, ensure the client is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  properly signed or run the host with `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  in **debug** mode only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If no hosts are found, open one of the host apps (Peekaboo.app or OpenClaw.app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and confirm permissions are granted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
