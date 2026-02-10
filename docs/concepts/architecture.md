---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "WebSocket gateway architecture, components, and client flows"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on gateway protocol, clients, or transports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway Architecture"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Last updated: 2026-01-22（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A single long‑lived **Gateway** owns all messaging surfaces (WhatsApp via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control-plane clients (macOS app, CLI, web UI, automations) connect to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Gateway over **WebSocket** on the configured bind host (default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `127.0.0.1:18789`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Nodes** (macOS/iOS/Android/headless) also connect over **WebSocket**, but（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  declare `role: node` with explicit caps/commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One Gateway per host; it is the only place that opens a WhatsApp session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A **canvas host** (default `18793`) serves agent‑editable HTML and A2UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Components and flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway (daemon)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Maintains provider connections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exposes a typed WS API (requests, responses, server‑push events).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Validates inbound frames against JSON Schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Emits events like `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Clients (mac app / CLI / web admin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One WS connection per client.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send requests (`health`, `status`, `send`, `agent`, `system-presence`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Subscribe to events (`tick`, `agent`, `presence`, `shutdown`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nodes (macOS / iOS / Android / headless)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connect to the **same WS server** with `role: node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provide a device identity in `connect`; pairing is **device‑based** (role `node`) and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  approval lives in the device pairing store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expose commands like `canvas.*`, `camera.*`, `screen.record`, `location.get`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Protocol details:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway protocol](/gateway/protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### WebChat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Static UI that uses the Gateway WS API for chat history and sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In remote setups, connects through the same SSH/Tailscale tunnel as other（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Connection lifecycle (single client)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```mermaid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
%%{init: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'theme': 'base',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'themeVariables': {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryTextColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryBorderColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'lineColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'secondaryColor': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'tertiaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBkg': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'nodeBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'mainBkg': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'edgeLabelBackground': '#ffffff'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}}%%（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sequenceDiagram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    participant Client（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    participant Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Client->>Gateway: req:connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway-->>Client: res (ok)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Note right of Gateway: or res error + close（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Note left of Client: payload=hello-ok<br>snapshot: presence + health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway-->>Client: event:presence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway-->>Client: event:tick（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Client->>Gateway: req:agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway-->>Client: res:agent<br>ack {runId, status:"accepted"}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway-->>Client: event:agent<br>(streaming)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Gateway-->>Client: res:agent<br>final {runId, status, summary}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Wire protocol (summary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Transport: WebSocket, text frames with JSON payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First frame **must** be `connect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After handshake:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `OPENCLAW_GATEWAY_TOKEN` (or `--token`) is set, `connect.params.auth.token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  must match or the socket closes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Idempotency keys are required for side‑effecting methods (`send`, `agent`) to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  safely retry; the server keeps a short‑lived dedupe cache.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes must include `role: "node"` plus caps/commands/permissions in `connect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing + local trust（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All WS clients (operators + nodes) include a **device identity** on `connect`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- New device IDs require pairing approval; the Gateway issues a **device token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  for subsequent connects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local** connects (loopback or the gateway host’s own tailnet address) can be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  auto‑approved to keep same‑host UX smooth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Non‑local** connects must sign the `connect.challenge` nonce and require（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  explicit approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway auth (`gateway.auth.*`) still applies to **all** connections, local or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  remote.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Gateway protocol](/gateway/protocol), [Pairing](/channels/pairing),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Protocol typing and codegen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TypeBox schemas define the protocol.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSON Schema is generated from those schemas.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Swift models are generated from the JSON Schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Preferred: Tailscale or VPN.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Alternative: SSH tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ssh -N -L 18789:127.0.0.1:18789 user@host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The same handshake + auth token apply over the tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TLS + optional pinning can be enabled for WS in remote setups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operations snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start: `openclaw gateway` (foreground, logs to stdout).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Health: `health` over WS (also included in `hello-ok`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Supervision: launchd/systemd for auto‑restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Invariants（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exactly one Gateway controls a single Baileys session per host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Handshake is mandatory; any non‑JSON or non‑connect first frame is a hard close.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Events are not replayed; clients must refresh on gaps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
