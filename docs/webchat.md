---
summary: "Loopback WebChat static host and Gateway WS usage for chat UI"
read_when:
  - Debugging or configuring WebChat access
---
# WebChat (loopback + SSH tunnel)

Updated: 2025-12-09

## What it is
- A local web UI for chatting with the Gateway, now WS-only for data.
- Static assets served by the WebChat HTTP server (default port **18788**, configurable).
- The browser/WebView connects directly to the Gateway WebSocket (`ws://127.0.0.1:18789` by default) for history, sends, and events. No file watching or HTTP RPC.
- Trust model: access is granted by being on localhost or inside your SSH/Tailscale tunnel. No additional auth prompts once you can reach the box.
- `webchat.gatewayPort` config can point at a non-default Gateway port if needed.

## Endpoints
- UI is served at the root: `http://127.0.0.1:<port>/` (legacy `/webchat/` still works).
- `GET /` (or `/webchat/*`) → static assets only. No RPC endpoints.
- Data plane is entirely on the Gateway WS (`ws://127.0.0.1:<gatewayPort>`): methods `chat.history`, `chat.send`; events `chat`, `presence`, `tick`, `health`.

## How it connects
- Browser/WebView performs Gateway WS `hello`, then calls `chat.history` for bootstrap and `chat.send` for sends; listens to `chat/presence/tick/health` events.
- No session file watching. History comes from the Gateway via `chat.history`.
- If Gateway WS is unavailable, the UI surfaces the error and blocks send.

## Remote use
- SSH tunnel example: `ssh -N -L 18788:127.0.0.1:18788 -L 18789:127.0.0.1:18789 user@host`.
- Browse to `http://127.0.0.1:18788/webchat/?session=<key>` through the tunnel; the backend WS also rides the tunnel.

## Config
- `webchat.enabled` (default true)
- `webchat.port` (default 18788)
- Gateway WS port is set by `clawdis gateway --port`; WebChat expects it at 18789 unless overridden.

## Failure handling
- UI errors when the Gateway handshake fails or the WS drops; no HTTP fallback.
- WebChat does not attempt fallback transports; the Gateway WS is required.

## Dev notes
- Assets live in `apps/macos/Sources/Clawdis/Resources/WebChat`.
- Static host: `src/webchat/server.ts` (loopback-only HTTP).
- macOS glue: `WebChatWindow.swift` + `WebChatTunnel` for SSH -L helpers; WKWebView talks directly to Gateway WS.
