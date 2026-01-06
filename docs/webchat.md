---
summary: "Loopback WebChat static host and Gateway WS usage for chat UI"
read_when:
  - Debugging or configuring WebChat access
---
# WebChat (SwiftUI + Gateway WS)

Updated: 2025-12-17

## What it is
- A native SwiftUI chat UI (macOS app / iOS) that talks directly to the Gateway WebSocket.
- No embedded browser/WKWebView and no bundled static WebChat HTTP server.
- Data plane is entirely Gateway WS: methods `chat.history`, `chat.send`, `chat.abort`; events `chat`, `agent`, `presence`, `tick`, `health`.

## How it connects
- The UI performs Gateway WS `connect`, then calls `chat.history` for bootstrap and `chat.send` for sends; it listens to `chat/agent/presence/tick/health` events.
- History comes from the Gateway via `chat.history` (no local session file watching).
- If Gateway WS is unavailable, the UI surfaces the error and blocks send.

## Remote use
- In remote mode, the macOS app forwards the Gateway WebSocket control port via SSH and uses that for the SwiftUI chat UI.
- You generally should not need to manage tunnels manually; see `RemoteTunnelManager` in the app.

## Config
- WebChat does not have a separate HTTP port/config anymore.
- Gateway WS is configured via the app’s gateway endpoint settings (`GatewayEndpointStore`) or `clawdbot gateway --port` when running locally.

## Failure handling
- UI errors when the Gateway handshake fails or the WS drops.
- No fallback transport; the Gateway WS is required.

## Dev notes
- macOS glue: [`apps/macos/Sources/Clawdbot/WebChatSwiftUI.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/WebChatSwiftUI.swift) + [`apps/macos/Sources/Clawdbot/WebChatManager.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/WebChatManager.swift).
- Remote tunnel helper: [`apps/macos/Sources/Clawdbot/RemotePortTunnel.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/RemotePortTunnel.swift).
