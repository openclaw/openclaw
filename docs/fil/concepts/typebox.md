---
summary: "Mga TypeBox schema bilang iisang pinanggagalingan ng katotohanan para sa Gateway protocol"
read_when:
  - Pag-a-update ng mga protocol schema o codegen
title: "TypeBox"
---

# TypeBox bilang pinagmumulan ng katotohanan ng protocol

Huling na-update: 2026-01-10

TypeBox is a TypeScript-first schema library. We use it to define the **Gateway
WebSocket protocol** (handshake, request/response, server events). Those schemas
drive **runtime validation**, **JSON Schema export**, and **Swift codegen** for
the macOS app. One source of truth; everything else is generated.

Kung gusto mo ang mas mataas na antas na konteksto ng protocol, magsimula sa
[Gateway architecture](/concepts/architecture).

## Mental model (30 segundo)

Bawat Gateway WS message ay isa sa tatlong frame:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

The first frame **must** be a `connect` request. After that, clients can call
methods (e.g. `health`, `send`, `chat.send`) and subscribe to events (e.g.
`presence`, `tick`, `agent`).

Daloy ng koneksyon (minimal):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Mga karaniwang method + event:

| Category  | Mga halimbawa                                             | Mga tala                                           |
| --------- | --------------------------------------------------------- | -------------------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` ang dapat mauna                          |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | kailangan ng `idempotencyKey` para sa side-effects |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | Ginagamit ito ng WebChat                           |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | session admin                                      |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + mga aksyon ng node                    |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                                        |

Ang awtoritatibong listahan ay nasa `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Saan nakalagay ang mga schema

- Source: `src/gateway/protocol/schema.ts`
- Runtime validators (AJV): `src/gateway/protocol/index.ts`
- Server handshake + method dispatch: `src/gateway/server.ts`
- Node client: `src/gateway/client.ts`
- Generated JSON Schema: `dist/protocol.schema.json`
- Generated Swift models: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Kasalukuyang pipeline

- `pnpm protocol:gen`
  - nagsusulat ng JSON Schema (draft‑07) sa `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - nagge-generate ng Swift gateway models
- `pnpm protocol:check`
  - pinapatakbo ang parehong generator at sine-secure na committed ang output

## Paano ginagamit ang mga schema sa runtime

- **Server side**: every inbound frame is validated with AJV. The handshake only
  accepts a `connect` request whose params match `ConnectParams`.
- **Client side**: ang JS client ay vine-validate ang mga event at response frame bago gamitin ang mga ito.
- **Method surface**: ina-advertise ng Gateway ang suportadong `methods` at `events` sa `hello-ok`.

## Mga halimbawa ng frame

Connect (unang mensahe):

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 2,
    "maxProtocol": 2,
    "client": {
      "id": "openclaw-macos",
      "displayName": "macos",
      "version": "1.0.0",
      "platform": "macos 15.1",
      "mode": "ui",
      "instanceId": "A1B2"
    }
  }
}
```

Hello-ok response:

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 2,
    "server": { "version": "dev", "connId": "ws-1" },
    "features": { "methods": ["health"], "events": ["tick"] },
    "snapshot": {
      "presence": [],
      "health": {},
      "stateVersion": { "presence": 0, "health": 0 },
      "uptimeMs": 0
    },
    "policy": { "maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 30000 }
  }
}
```

Request + response:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Event:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Minimal na client (Node.js)

Pinakamaliit na kapaki-pakinabang na daloy: connect + health.

```ts
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "example",
          version: "dev",
          platform: "node",
          mode: "cli",
        },
      },
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === "res" && msg.id === "c1" && msg.ok) {
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
  }
  if (msg.type === "res" && msg.id === "h1") {
    console.log("health:", msg.payload);
    ws.close();
  }
});
```

## Worked example: magdagdag ng method end‑to‑end

Halimbawa: magdagdag ng bagong `system.echo` request na nagbabalik ng `{ ok: true, text }`.

1. **Schema (pinagmumulan ng katotohanan)**

Idagdag sa `src/gateway/protocol/schema.ts`:

```ts
export const SystemEchoParamsSchema = Type.Object(
  { text: NonEmptyString },
  { additionalProperties: false },
);

export const SystemEchoResultSchema = Type.Object(
  { ok: Type.Boolean(), text: NonEmptyString },
  { additionalProperties: false },
);
```

Idagdag ang pareho sa `ProtocolSchemas` at i-export ang mga type:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validation**

Sa `src/gateway/protocol/index.ts`, mag-export ng AJV validator:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Server behavior**

Magdagdag ng handler sa `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

I-register ito sa `src/gateway/server-methods.ts` (na nagme-merge na ng `systemHandlers`),
pagkatapos ay idagdag ang `"system.echo"` sa `METHODS` sa `src/gateway/server.ts`.

4. **Regenerate**

```bash
pnpm protocol:check
```

5. **Mga test + docs**

Magdagdag ng server test sa `src/gateway/server.*.test.ts` at banggitin ang method sa docs.

## Swift codegen behavior

Ang Swift generator ay naglalabas ng:

- `GatewayFrame` enum na may mga case na `req`, `res`, `event`, at `unknown`
- Strongly typed na payload structs/enums
- Mga value ng `ErrorCode` at `GATEWAY_PROTOCOL_VERSION`

Ang mga hindi kilalang frame type ay pinapanatili bilang raw payloads para sa forward compatibility.

## Versioning + compatibility

- Ang `PROTOCOL_VERSION` ay nasa `src/gateway/protocol/schema.ts`.
- Nagpapadala ang mga client ng `minProtocol` + `maxProtocol`; tinatanggihan ng server ang mga mismatch.
- Pinapanatili ng Swift models ang mga hindi kilalang frame type upang maiwasang masira ang mas lumang mga client.

## Mga pattern at kumbensyon ng schema

- Karamihan sa mga object ay gumagamit ng `additionalProperties: false` para sa mahigpit na payload.
- Ang `NonEmptyString` ang default para sa mga ID at pangalan ng method/event.
- Ang top-level na `GatewayFrame` ay gumagamit ng **discriminator** sa `type`.
- Ang mga method na may side effects ay karaniwang nangangailangan ng `idempotencyKey` sa params
  (halimbawa: `send`, `poll`, `agent`, `chat.send`).

## Live schema JSON

Generated JSON Schema is in the repo at `dist/protocol.schema.json`. The
published raw file is typically available at:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Kapag binabago mo ang mga schema

1. I-update ang mga TypeBox schema.
2. Patakbuhin ang `pnpm protocol:check`.
3. I-commit ang na-regenerate na schema + Swift models.
