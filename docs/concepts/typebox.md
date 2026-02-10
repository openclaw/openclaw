---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "TypeBox schemas as the single source of truth for the gateway protocol"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating protocol schemas or codegen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "TypeBox"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# TypeBox as protocol source of truth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Last updated: 2026-01-10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TypeBox is a TypeScript-first schema library. We use it to define the **Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WebSocket protocol** (handshake, request/response, server events). Those schemas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
drive **runtime validation**, **JSON Schema export**, and **Swift codegen** for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the macOS app. One source of truth; everything else is generated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the higher-level protocol context, start with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Gateway architecture](/concepts/architecture).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mental model (30 seconds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every Gateway WS message is one of three frames:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Request**: `{ type: "req", id, method, params }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Response**: `{ type: "res", id, ok, payload | error }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The first frame **must** be a `connect` request. After that, clients can call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
methods (e.g. `health`, `send`, `chat.send`) and subscribe to events (e.g.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`presence`, `tick`, `agent`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Connection flow (minimal):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Client                    Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  |---- req:connect -------->|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  |<---- res:hello-ok --------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  |<---- event:tick ----------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  |---- req:health ---------->|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  |<---- res:health ----------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common methods + events:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Category  | Examples                                                  | Notes                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | --------------------------------------------------------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Core      | `connect`, `health`, `status`                             | `connect` must be first            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | side-effects need `idempotencyKey` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat uses these                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | session admin                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + node actions          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Authoritative list lives in `src/gateway/server.ts` (`METHODS`, `EVENTS`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where the schemas live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Source: `src/gateway/protocol/schema.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime validators (AJV): `src/gateway/protocol/index.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Server handshake + method dispatch: `src/gateway/server.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node client: `src/gateway/client.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Generated JSON Schema: `dist/protocol.schema.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Generated Swift models: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm protocol:gen`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - writes JSON Schema (draft‑07) to `dist/protocol.schema.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm protocol:gen:swift`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - generates Swift gateway models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm protocol:check`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - runs both generators and verifies the output is committed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How the schemas are used at runtime（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Server side**: every inbound frame is validated with AJV. The handshake only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  accepts a `connect` request whose params match `ConnectParams`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Client side**: the JS client validates event and response frames before（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  using them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Method surface**: the Gateway advertises the supported `methods` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `events` in `hello-ok`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example frames（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Connect (first message):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "req",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "c1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "method": "connect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "params": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "minProtocol": 2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "maxProtocol": 2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "client": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "id": "openclaw-macos",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "displayName": "macos",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "version": "1.0.0",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "platform": "macos 15.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "mode": "ui",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "instanceId": "A1B2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hello-ok response:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "res",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "c1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "ok": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "payload": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "hello-ok",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "protocol": 2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "server": { "version": "dev", "connId": "ws-1" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "features": { "methods": ["health"], "events": ["tick"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "snapshot": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "presence": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "health": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "stateVersion": { "presence": 0, "health": 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "uptimeMs": 0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "policy": { "maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 30000 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Request + response:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "type": "req", "id": "r1", "method": "health" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Event:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Minimal client (Node.js)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Smallest useful flow: connect + health.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { WebSocket } from "ws";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const ws = new WebSocket("ws://127.0.0.1:18789");（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ws.on("open", () => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ws.send(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    JSON.stringify({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      type: "req",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      id: "c1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      method: "connect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minProtocol: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxProtocol: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        client: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          id: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          displayName: "example",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          version: "dev",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          platform: "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mode: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  );（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ws.on("message", (data) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  const msg = JSON.parse(String(data));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if (msg.type === "res" && msg.id === "c1" && msg.ok) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if (msg.type === "res" && msg.id === "h1") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    console.log("health:", msg.payload);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ws.close();（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Worked example: add a method end‑to‑end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: add a new `system.echo` request that returns `{ ok: true, text }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Schema (source of truth)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add to `src/gateway/protocol/schema.ts`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export const SystemEchoParamsSchema = Type.Object(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { text: NonEmptyString },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { additionalProperties: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export const SystemEchoResultSchema = Type.Object(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { ok: Type.Boolean(), text: NonEmptyString },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { additionalProperties: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add both to `ProtocolSchemas` and export types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SystemEchoParams: SystemEchoParamsSchema,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SystemEchoResult: SystemEchoResultSchema,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Validation**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In `src/gateway/protocol/index.ts`, export an AJV validator:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Server behavior**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a handler in `src/gateway/server-methods/system.ts`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export const systemHandlers: GatewayRequestHandlers = {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "system.echo": ({ params, respond }) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    const text = String(params.text ?? "");（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    respond(true, { ok: true, text });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Register it in `src/gateway/server-methods.ts` (already merges `systemHandlers`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
then add `"system.echo"` to `METHODS` in `src/gateway/server.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Regenerate**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm protocol:check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Tests + docs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a server test in `src/gateway/server.*.test.ts` and note the method in docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Swift codegen behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Swift generator emits:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GatewayFrame` enum with `req`, `res`, `event`, and `unknown` cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Strongly typed payload structs/enums（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ErrorCode` values and `GATEWAY_PROTOCOL_VERSION`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unknown frame types are preserved as raw payloads for forward compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Versioning + compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PROTOCOL_VERSION` lives in `src/gateway/protocol/schema.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients send `minProtocol` + `maxProtocol`; the server rejects mismatches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Swift models keep unknown frame types to avoid breaking older clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Schema patterns and conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Most objects use `additionalProperties: false` for strict payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `NonEmptyString` is the default for IDs and method/event names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The top-level `GatewayFrame` uses a **discriminator** on `type`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Methods with side effects usually require an `idempotencyKey` in params（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (example: `send`, `poll`, `agent`, `chat.send`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Live schema JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generated JSON Schema is in the repo at `dist/protocol.schema.json`. The（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
published raw file is typically available at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When you change schemas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Update the TypeBox schemas.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run `pnpm protocol:check`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Commit the regenerated schema + Swift models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
