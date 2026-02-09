---
summary: "TypeBox-scheman som den enda sanningskällan för gateway-protokollet"
read_when:
  - Uppdaterar protokollscheman eller codegen
title: "TypeBox"
---

# TypeBox som protokollets enda sanningskälla

Senast uppdaterad: 2026-01-10

TypeBox är ett TypeScript-första schemabibliotek. Vi använder det för att definiera **Gateway
WebSocket-protokollet** (handskakning, förfrågan/svar, serverhändelser). Dessa scheman
kör **körtidsvalidering**, **JSON Schema export**, och **Swift codegen** för
macOS appen. En källa till sanning; allt annat genereras.

Om du vill ha sammanhang på protokollnivå, börja med
[Gateway-arkitektur](/concepts/architecture).

## Mental modell (30 sekunder)

Varje Gateway WS‑meddelande är en av tre ramar:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Händelse**: `{ typ: "händelse", händelse, nyttolast, q?, stateVersion? }`

Den första ramen **måste** vara en `connect`-begäran. Därefter kan klienter anropa
metoder (t.ex. `health`, `send`, `chat.send`) och prenumerera på händelser (t.ex.
`presence`, `tick`, `agent`).

Anslutningsflöde (minimalt):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Vanliga metoder + händelser:

| Kategori  | Exempel                                                   | Noteringar                           |
| --------- | --------------------------------------------------------- | ------------------------------------ |
| Core      | `connect`, `health`, `status`                             | `connect` måste vara först           |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | sidoeffekter kräver `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat använder dessa               |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | sessionadministration                |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + nodåtgärder             |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | serverpush                           |

Den auktoritativa listan finns i `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Var schemana finns

- Källa: `src/gateway/protocol/schema.ts`
- Validerare vid körning (AJV): `src/gateway/protocol/index.ts`
- Server‑handshake + metoddispatch: `src/gateway/server.ts`
- Node‑klient: `src/gateway/client.ts`
- Genererat JSON Schema: `dist/protocol.schema.json`
- Genererade Swift‑modeller: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Aktuell pipeline

- `pnpm protocol:gen`
  - skriver JSON Schema (draft‑07) till `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - genererar Swift‑gateway‑modeller
- `pnpm protocol:check`
  - kör båda generatorerna och verifierar att utdata är committat

## Hur schemana används vid körning

- **Serversidan**: varje inkommande ram är validerad med AJV. Handskakningen endast
  accepterar en `connect`-begäran vars parametrar matchar `ConnectParams`.
- **Klientsidan**: JS‑klienten validerar händelse‑ och svarsrutor innan de används.
- **Metodyta**: Gateway annonserar de stödda `methods` och `events` i `hello-ok`.

## Exempel på ramar

Anslut (första meddelandet):

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

Hello‑ok‑svar:

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

Minsta användbara flöde: anslut + hälsa.

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

## Genomgånget exempel: lägg till en metod från början till slut

Exempel: lägg till en ny `system.echo`‑request som returnerar `{ ok: true, text }`.

1. **Schema (sanningskälla)**

Lägg till i `src/gateway/protocol/schema.ts`:

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

Lägg till båda i `ProtocolSchemas` och exportera typer:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validering**

I `src/gateway/protocol/index.ts`, exportera en AJV‑validerare:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Serverbeteende**

Lägg till en handler i `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Registrera den i `src/gateway/server-methods.ts` (slår redan samman `systemHandlers`),
lägg sedan till `"system.echo"` i `METHODS` i `src/gateway/server.ts`.

4. **Regenerera**

```bash
pnpm protocol:check
```

5. **Tester + dokumentation**

Lägg till ett servertest i `src/gateway/server.*.test.ts` och notera metoden i dokumentationen.

## Swift‑codegen‑beteende

Swift‑generatorn emitterar:

- `GatewayFrame`‑enum med `req`, `res`, `event` och `unknown`‑fall
- Starkt typade payload‑structs/enums
- `ErrorCode`‑värden och `GATEWAY_PROTOCOL_VERSION`

Okända ramtyper bevaras som råa payloads för framåtkompatibilitet.

## Versionering + kompatibilitet

- `PROTOCOL_VERSION` finns i `src/gateway/protocol/schema.ts`.
- Klienter skickar `minProtocol` + `maxProtocol`; servern avvisar mismatchar.
- Swift‑modellerna behåller okända ramtyper för att undvika att äldre klienter bryts.

## Schemamönster och konventioner

- De flesta objekt använder `additionalProperties: false` för strikta payloads.
- `NonEmptyString` är standard för ID:n och metod-/händelsenamn.
- Den översta `GatewayFrame` använder en **discriminator** på `type`.
- Metoder med sidoeffekter kräver vanligtvis en `idempotencyKey` i parametrarna
  (exempel: `send`, `poll`, `agent`, `chat.send`).

## Live‑schema‑JSON

Genererad JSON Schema finns i repo på `dist/protocol.schema.json`. Den
publicerade rå filen är vanligtvis tillgänglig på:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## När du ändrar scheman

1. Uppdatera TypeBox‑schemana.
2. Kör `pnpm protocol:check`.
3. Committa det regenererade schemat + Swift‑modellerna.
