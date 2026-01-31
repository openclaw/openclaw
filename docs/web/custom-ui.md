---
summary: "Build a custom web UI that talks to the Gateway WebSocket"
read_when:
  - You want to build your own browser app for OpenClaw
  - You want to connect a web UI to the Gateway WebSocket
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
