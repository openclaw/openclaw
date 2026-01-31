---
summary: "Build a custom web UI that talks to the Gateway WebSocket"
read_when:
  - You want to build your own browser app for OpenClaw
  - You want to connect a web UI to the Gateway WebSocket
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
---

# Custom web UI

OpenClaw already ships a Control UI (Vite + Lit) that talks directly to the
Gateway WebSocket on the same port. You can use that app as a reference
implementation while building your own UI. See [Control UI](/web/control-ui)
for the full feature list and WebSocket auth behavior.

This guide focuses on a safe development loop, build outputs, and the Gateway
surfaces a custom UI should use.

## Local development loop

Run the bundled Control UI in dev mode to validate your Gateway setup:

```bash
pnpm ui:dev
```

Then open the dev server and point it at your Gateway:

```
http://localhost:5173/?gatewayUrl=ws://127.0.0.1:18789
```

Optional one-time auth:

```
http://localhost:5173/?gatewayUrl=ws://127.0.0.1:18789&token=<gateway-token>
```

The dev server stores `gatewayUrl` and `token` in localStorage after load and
removes them from the URL. For remote setups, see [Remote access](/gateway/remote).

## Build outputs and hosting

`pnpm ui:build` compiles the Control UI into `dist/control-ui`, which the
Gateway can serve directly. See [Web surfaces](/web) and [Control UI](/web/control-ui)
for details on `gateway.controlUi.basePath`, authentication, and secure access.

If you serve the UI from a separate host, keep the WebSocket endpoint reachable
and use the Gateway WebSocket protocol described in [Gateway protocol](/gateway/protocol).

## Gateway integration points

The Control UI demonstrates the current WebSocket surfaces a custom web app can
reuse, including:

- Chat history and send flows (`chat.history`, `chat.send`, `chat.abort`)
- Channel status and configuration (`channels.status`, `config.patch`)
- Sessions, nodes, and presence (`sessions.list`, `node.list`, `system-presence`)
- Cron automation (`cron.*`)

See the full list in [Control UI](/web/control-ui).

## Feature intake checklist

When you want to move features from other web apps into OpenClaw, align each
capability to a Gateway surface so it can run consistently across channels:

1. **Real-time chat or collaboration**
   - Map to `chat.*` calls over the Gateway WebSocket.
2. **Automations and workflow triggers**
   - Use [Webhooks](/automation/webhook) for inbound events.
   - Use [Cron jobs](/automation/cron-jobs) for scheduled tasks.
3. **Integrations with external tools**
   - Prefer channel plugins or tool calls that already exist in OpenClaw.
4. **Configuration panels**
   - Drive changes through `config.get`, `config.set`, and `config.apply`.
5. **User access and security**
   - Use Gateway auth modes and avoid exposing the control plane publicly.
   - Review [Web surfaces](/web) for bind and security guidance.

Document the mapping for each feature before implementation so the OpenClaw UI,
CLI, and Gateway remain consistent.

## Example capability inventory

If you are planning a custom UI, capture the intended scope up front and map
each item to the closest OpenClaw surface. Here is a sample inventory based on
common requests:

### Channels

- WhatsApp: [WhatsApp](/channels/whatsapp)
- Telegram: [Telegram](/channels/telegram)
- Microsoft Teams (plugin): [Microsoft Teams](/channels/msteams)

### Models

Model providers and credentials live in Gateway configuration; verify the
providers you plan to use are supported in your deployment. Start in
[Gateway configuration](/gateway/configuration).

### Productivity integrations

Plan an ingestion and authorization flow first (for example, Notion, GitHub,
Obsidian). Each integration should map to a tool call or webhook, not direct UI
logic. See [Webhooks](/automation/webhook).

### Tools and automation

- Browser tooling: [Browser tool](/tools/browser)
- Canvas and screen automation: [Canvas](/platforms/mac/canvas)
- Voice wake and talk mode: [Voice wake](/nodes/voicewake)
- Cron scheduling: [Cron jobs](/automation/cron-jobs)
- Webhooks: [Webhooks](/automation/webhook)

### Media and creative

- Camera capture: [Camera node](/nodes/camera)
- Image understanding and attachments: [Images](/nodes/images)

### Platform targets

Confirm your UI runs on the intended platforms (for example, Windows) and uses
the Gateway WebSocket as the shared control plane.

- `gatewayUrl` is stored in localStorage after load and removed from the URL.
- `token` is stored in localStorage; `password` is kept in memory only.
- Use `wss://` when the Gateway is behind TLS (Tailscale Serve, HTTPS proxy, etc.).

Remote access setup details: [Remote access](/gateway/remote).
