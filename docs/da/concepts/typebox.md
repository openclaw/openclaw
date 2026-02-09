---
summary: "TypeBox-skemaer som den eneste sandhedskilde for gateway-protokollen"
read_when:
  - Opdatering af protokolskemaer eller kodegenerering
title: "TypeBox"
---

# TypeBox som protokollens sandhedskilde

Senest opdateret: 2026-01-10

TypeBox er et TypeScript-første skema bibliotek. Vi bruger den til at definere \*\* Gateway
WebSocket protokol\*\* (håndtryk, anmodning/svar, server begivenheder). Disse skemaer
drev **runtime validering**, **JSON Schema export**, og **Swift codegen** for
macOS app. En kilde til sandhed; alt andet genereres.

Hvis du vil have den overordnede protokol-kontekst, så start med
[Gateway-arkitektur](/concepts/architecture).

## Mental model (30 sekunder)

Hver Gateway WS-besked er én af tre frames:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Begivenhed**: `{ type: "begivenhed", event, nyttelast, seq?, stateVersion? }`

Den første ramme **must** være en `connect` anmodning. Derefter kan klienter kalde
metoder (f.eks. `health`, `send`, `chat.send`) og abonnere på begivenheder (f.eks.
`tilstedeværelse`, `tick`, `agent`).

Forbindelsesflow (minimalt):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Almindelige metoder + events:

| Kategori  | Eksempler                                                 | Noter                                 |
| --------- | --------------------------------------------------------- | ------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` skal være først             |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | side-effekter kræver `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat bruger disse                  |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | session-administration                |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + node-handlinger          |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                           |

Den autoritative liste findes i `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Hvor skemaerne ligger

- Kilde: `src/gateway/protocol/schema.ts`
- Runtime-validatorer (AJV): `src/gateway/protocol/index.ts`
- Server-handshake + metode-dispatch: `src/gateway/server.ts`
- Node-klient: `src/gateway/client.ts`
- Genereret JSON Schema: `dist/protocol.schema.json`
- Genererede Swift-modeller: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Nuværende pipeline

- `pnpm protocol:gen`
  - skriver JSON Schema (draft‑07) til `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - genererer Swift gateway-modeller
- `pnpm protocol:check`
  - kører begge generatorer og verificerer, at outputtet er committet

## Hvordan skemaerne bruges ved runtime

- \*\*Serversiden \*\*: Alle indgående rammer er valideret med AJV. Håndtrykket kun
  accepterer en `connect` anmodning, hvis params matcher `ConnectParams`.
- **Klientside**: JS-klienten validerer event- og response-frames, før de
  bruges.
- **Metadeflade**: Gateway annoncerer de understøttede `methods` og
  `events` i `hello-ok`.

## Eksempel-frames

Connect (første besked):

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

Hello-ok-svar:

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

## Minimal klient (Node.js)

Mindste nyttige flow: connect + health.

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

## Gennemarbejdet eksempel: tilføj en metode end‑to‑end

Eksempel: tilføj en ny `system.echo`-request, der returnerer `{ ok: true, text }`.

1. **Skema (sandhedskilde)**

Tilføj til `src/gateway/protocol/schema.ts`:

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

Tilføj begge til `ProtocolSchemas` og eksportér typer:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validering**

I `src/gateway/protocol/index.ts`, eksportér en AJV-validator:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Serveradfærd**

Tilføj en handler i `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Registrér den i `src/gateway/server-methods.ts` (som allerede merger `systemHandlers`),
og tilføj derefter `"system.echo"` til `METHODS` i `src/gateway/server.ts`.

4. **Regenerér**

```bash
pnpm protocol:check
```

5. **Tests + docs**

Tilføj en servertest i `src/gateway/server.*.test.ts` og noter metoden i dokumentationen.

## Swift-kodegenereringens adfærd

Swift-generatoren udleder:

- `GatewayFrame` enum med `req`, `res`, `event` og `unknown` cases
- Stærkt typede payload-strukturer/enums
- `ErrorCode`-værdier og `GATEWAY_PROTOCOL_VERSION`

Ukendte frametyper bevares som rå payloads for fremadrettet kompatibilitet.

## Versionering + kompatibilitet

- `PROTOCOL_VERSION` ligger i `src/gateway/protocol/schema.ts`.
- Klienter sender `minProtocol` + `maxProtocol`; serveren afviser mismatch.
- Swift-modellerne bevarer ukendte frametyper for at undgå at bryde ældre klienter.

## Skemamønstre og konventioner

- De fleste objekter bruger `additionalProperties: false` til strikse payloads.
- `NonEmptyString` er standarden for ID’er og metode-/eventnavne.
- Den øverste `GatewayFrame` bruger en **discriminator** på `type`.
- Metoder med side-effekter kræver typisk en `idempotencyKey` i params
  (eksempel: `send`, `poll`, `agent`, `chat.send`).

## Live schema JSON

Genereret JSON Schema er i repo på `dist/protocol.schema.json`. Den
offentliggjorte råfil er typisk tilgængelig på:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Når du ændrer skemaer

1. Opdatér TypeBox-skemaerne.
2. Kør `pnpm protocol:check`.
3. Commit det regenererede skema + Swift-modeller.
