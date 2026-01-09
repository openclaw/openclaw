---
summary: "Loopback WebChat static host and Gateway WS usage for chat UI"
read_when:
  - Debugging or configuring WebChat access
---
# WebChat (Gateway WebSocket UI)


Status: the macOS/iOS SwiftUI chat UI talks directly to the Gateway WebSocket.

## What it is
- A native chat UI for the gateway (no embedded browser and no local static server).
- Uses the same sessions and routing rules as other providers.
- Deterministic routing: replies always go back to WebChat.

## How it works (behavior)
- The UI connects to the Gateway WebSocket and uses `chat.history` + `chat.send`.
- History is always fetched from the gateway (no local file watching).
- If the gateway is unreachable, WebChat is read-only.

## Remote use
- Remote mode tunnels the gateway WebSocket over SSH/Tailscale.
- You do not need to run a separate WebChat server.

## Configuration reference (WebChat)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- No dedicated `webchat.*` block. WebChat uses the gateway endpoint + auth settings below.

Related global options:
- `gateway.port`, `gateway.bind`: WebSocket host/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket auth.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote gateway target.
- `session.*`: session storage and main key defaults.
