---
summary: "TypeBox-schema’s als de enige bron van waarheid voor het gateway-protocol"
read_when:
  - Bijwerken van protocols schema’s of codegeneratie
title: "TypeBox"
---

# TypeBox als bron van waarheid voor het protocol

Laatst bijgewerkt: 2026-01-10

TypeBox is een TypeScript-first schemabibliotheek. We gebruiken het om het **Gateway
WebSocket-protocol** te definiëren (handshake, request/response, serverevents). Deze schema’s
sturen **runtime-validatie**, **JSON Schema-export** en **Swift-codegeneratie** voor
de macOS-app aan. Eén bron van waarheid; al het andere wordt gegenereerd.

Als je de protocolcontext op hoger niveau wilt, begin dan met
[Gateway architecture](/concepts/architecture).

## Mentaal model (30 seconden)

Elk Gateway WS-bericht is een van drie frames:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

Het eerste frame **moet** een `connect`-request zijn. Daarna kunnen clients
methoden aanroepen (bijv. `health`, `send`, `chat.send`) en zich
abonneren op events (bijv. `presence`, `tick`, `agent`).

Verbindingsflow (minimaal):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Veelgebruikte methoden + events:

| Categorie | Voorbeelden                                               | Notities                               |
| --------- | --------------------------------------------------------- | -------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` moet eerst zijn              |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | side-effects vereisen `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat gebruikt deze                  |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | sessiebeheer                           |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + node-acties               |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                            |

De gezaghebbende lijst staat in `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Waar de schema’s staan

- Bron: `src/gateway/protocol/schema.ts`
- Runtime-validators (AJV): `src/gateway/protocol/index.ts`
- Server-handshake + methodedispatch: `src/gateway/server.ts`
- Node-client: `src/gateway/client.ts`
- Gegenereerd JSON Schema: `dist/protocol.schema.json`
- Gegenereerde Swift-modellen: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Huidige pipeline

- `pnpm protocol:gen`
  - schrijft JSON Schema (draft‑07) naar `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - genereert Swift Gateway-modellen
- `pnpm protocol:check`
  - draait beide generators en verifieert dat de uitvoer is gecommit

## Hoe de schema’s runtime worden gebruikt

- **Serverzijde**: elk inkomend frame wordt gevalideerd met AJV. De handshake
  accepteert alleen een `connect`-request waarvan de params overeenkomen met
  `ConnectParams`.
- **Clientzijde**: de JS-client valideert event- en responseframes voordat
  ze worden gebruikt.
- **Methodesurface**: de Gateway adverteert de ondersteunde `methods` en
  `events` in `hello-ok`.

## Voorbeeldframes

Verbinden (eerste bericht):

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

## Minimale client (Node.js)

Kleinste nuttige flow: verbinden + health.

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

## Uitgewerkt voorbeeld: voeg een methode end‑to‑end toe

Voorbeeld: voeg een nieuwe `system.echo`-request toe die `{ ok: true, text }` retourneert.

1. **Schema (bron van waarheid)**

Voeg toe aan `src/gateway/protocol/schema.ts`:

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

Voeg beide toe aan `ProtocolSchemas` en exporteer types:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validatie**

Exporteer in `src/gateway/protocol/index.ts` een AJV-validator:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Servergedrag**

Voeg een handler toe in `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Registreer deze in `src/gateway/server-methods.ts` (voegt `systemHandlers` al samen),
en voeg daarna `"system.echo"` toe aan `METHODS` in `src/gateway/server.ts`.

4. **Regenereren**

```bash
pnpm protocol:check
```

5. **Tests + documentatie**

Voeg een servertest toe in `src/gateway/server.*.test.ts` en vermeld de methode in de documentatie.

## Swift-codegeneratiegedrag

De Swift-generator levert:

- `GatewayFrame`-enum met `req`, `res`, `event` en `unknown`-cases
- Sterk getypeerde payload-structs/enums
- `ErrorCode`-waarden en `GATEWAY_PROTOCOL_VERSION`

Onbekende frametypen blijven behouden als ruwe payloads voor voorwaartse compatibiliteit.

## Versiebeheer + compatibiliteit

- `PROTOCOL_VERSION` staat in `src/gateway/protocol/schema.ts`.
- Clients sturen `minProtocol` + `maxProtocol`; de server weigert mismatches.
- De Swift-modellen behouden onbekende frametypen om oudere clients niet te breken.

## Schemepatronen en conventies

- De meeste objecten gebruiken `additionalProperties: false` voor strikte payloads.
- `NonEmptyString` is de standaard voor ID’s en methode-/eventnamen.
- Het top-level `GatewayFrame` gebruikt een **discriminator** op `type`.
- Methoden met side-effects vereisen meestal een `idempotencyKey` in params
  (voorbeeld: `send`, `poll`, `agent`, `chat.send`).

## Live schema-JSON

Gegenereerd JSON Schema staat in de repo op `dist/protocol.schema.json`. Het
gepubliceerde ruwe bestand is doorgaans beschikbaar op:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Wanneer je schema’s wijzigt

1. Werk de TypeBox-schema’s bij.
2. Voer `pnpm protocol:check` uit.
3. Commit het geregenereerde schema + de Swift-modellen.
