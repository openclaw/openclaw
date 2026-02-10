---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Loopback WebChat static host and Gateway WS usage for chat UI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging or configuring WebChat access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "WebChat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# WebChat (Gateway WebSocket UI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: the macOS/iOS SwiftUI chat UI talks directly to the Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A native chat UI for the gateway (no embedded browser and no local static server).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses the same sessions and routing rules as other channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic routing: replies always go back to WebChat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Open the WebChat UI (macOS/iOS app) or the Control UI chat tab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ensure gateway auth is configured (required by default, even on loopback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The UI connects to the Gateway WebSocket and uses `chat.history`, `chat.send`, and `chat.inject`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat.inject` appends an assistant note directly to the transcript and broadcasts it to the UI (no agent run).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- History is always fetched from the gateway (no local file watching).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the gateway is unreachable, WebChat is read-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote mode tunnels the gateway WebSocket over SSH/Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You do not need to run a separate WebChat server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (WebChat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No dedicated `webchat.*` block. WebChat uses the gateway endpoint + auth settings below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related global options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.port`, `gateway.bind`: WebSocket host/port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote gateway target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session.*`: session storage and main key defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
