---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "macOS IPC architecture for OpenClaw app, gateway node transport, and PeekabooBridge"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Editing IPC contracts or menu bar app IPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "macOS IPC"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw macOS IPC architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Current model:** a local Unix socket connects the **node host service** to the **macOS app** for exec approvals + `system.run`. A `openclaw-mac` debug CLI exists for discovery/connect checks; agent actions still flow through the Gateway WebSocket and `node.invoke`. UI automation uses PeekabooBridge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Single GUI app instance that owns all TCC-facing work (notifications, screen recording, mic, speech, AppleScript).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A small surface for automation: Gateway + node commands, plus PeekabooBridge for UI automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Predictable permissions: always the same signed bundle ID, launched by launchd, so TCC grants stick.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway + node transport（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app runs the Gateway (local mode) and connects to it as a node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent actions are performed via `node.invoke` (e.g. `system.run`, `system.notify`, `canvas.*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Node service + app IPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A headless node host service connects to the Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.run` requests are forwarded to the macOS app over a local Unix socket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app performs the exec in UI context, prompts if needed, and returns output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Diagram (SCI):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agent -> Gateway -> Node Service (WS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                      |  IPC (UDS + token + HMAC + TTL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                      v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                  Mac App (UI + TCC + system.run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### PeekabooBridge (UI automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI automation uses a separate UNIX socket named `bridge.sock` and the PeekabooBridge JSON protocol.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Host preference order (client-side): Peekaboo.app → Claude.app → OpenClaw.app → local execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: bridge hosts require an allowed TeamID; DEBUG-only same-UID escape hatch is guarded by `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo convention).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See: [PeekabooBridge usage](/platforms/mac/peekaboo) for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operational flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart/rebuild: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Kills existing instances（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Swift build + package（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Writes/bootstraps/kickstarts the LaunchAgent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Single instance: app exits early if another instance with the same bundle ID is running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hardening notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer requiring a TeamID match for all privileged surfaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) may allow same-UID callers for local development.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All communication remains local-only; no network sockets are exposed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TCC prompts originate only from the GUI app bundle; keep the signed bundle ID stable across rebuilds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- IPC hardening: socket mode `0600`, token, peer-UID checks, HMAC challenge/response, short TTL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
