---
summary: "TypeBox-Schemas als einzige Quelle der Wahrheit für das Gateway-Protokoll"
read_when:
  - Aktualisieren von Protokoll-Schemas oder Codegenerierung
title: "TypeBox"
---

# TypeBox als Quelle der Wahrheit für das Protokoll

Zuletzt aktualisiert: 2026-01-10

TypeBox ist eine TypeScript‑first Schema-Bibliothek. Wir verwenden sie, um das **Gateway‑WebSocket‑Protokoll** (Handshake, Request/Response, Server‑Events) zu definieren. Diese Schemas treiben die **Laufzeitvalidierung**, den **JSON‑Schema‑Export** und die **Swift‑Codegenerierung** für die macOS‑App an. Eine einzige Quelle der Wahrheit; alles andere wird daraus generiert.

Wenn Sie den übergeordneten Protokollkontext möchten, beginnen Sie mit
[Gateway architecture](/concepts/architecture).

## Mentales Modell (30 Sekunden)

Jede Gateway‑WS‑Nachricht ist eines von drei Frames:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

Der erste Frame **muss** eine `connect`‑Anfrage sein. Danach können Clients
Methoden aufrufen (z. B. `health`, `send`, `chat.send`) und Events abonnieren (z. B. `presence`, `tick`, `agent`).

Verbindungsablauf (minimal):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Häufige Methoden + Events:

| Kategorie | Beispiele                                                 | Hinweise                                  |
| --------- | --------------------------------------------------------- | ----------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` muss zuerst kommen              |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | Nebenwirkungen benötigen `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat verwendet diese                   |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | Sitzungsverwaltung                        |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway‑WS + Node‑Aktionen                |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | Server‑Push                               |

Die maßgebliche Liste befindet sich in `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Wo die Schemas liegen

- Quelle: `src/gateway/protocol/schema.ts`
- Laufzeit‑Validatoren (AJV): `src/gateway/protocol/index.ts`
- Server‑Handshake + Methoden‑Dispatch: `src/gateway/server.ts`
- Node‑Client: `src/gateway/client.ts`
- Generiertes JSON Schema: `dist/protocol.schema.json`
- Generierte Swift‑Modelle: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Aktuelle Pipeline

- `pnpm protocol:gen`
  - schreibt JSON Schema (Draft‑07) nach `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - generiert Swift‑Gateway‑Modelle
- `pnpm protocol:check`
  - führt beide Generatoren aus und überprüft, dass die Ausgabe committet ist

## Wie die Schemas zur Laufzeit verwendet werden

- **Serverseitig**: Jeder eingehende Frame wird mit AJV validiert. Der Handshake
  akzeptiert nur eine `connect`‑Anfrage, deren Parameter `ConnectParams` entsprechen.
- **Clientseitig**: Der JS‑Client validiert Event‑ und Response‑Frames, bevor
  er sie verwendet.
- **Methodenoberfläche**: Das Gateway kündigt die unterstützten `methods` und
  `events` in `hello-ok` an.

## Beispiel‑Frames

Connect (erste Nachricht):

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

Hello‑ok‑Antwort:

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

Request + Response:

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

## Minimaler Client (Node.js)

Kleinster sinnvoller Ablauf: verbinden + Health.

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

## Durchgängiges Beispiel: eine Methode Ende‑zu‑Ende hinzufügen

Beispiel: Fügen Sie eine neue `system.echo`‑Anfrage hinzu, die `{ ok: true, text }` zurückgibt.

1. **Schema (Quelle der Wahrheit)**

Zu `src/gateway/protocol/schema.ts` hinzufügen:

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

Beide zu `ProtocolSchemas` hinzufügen und Typen exportieren:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validierung**

In `src/gateway/protocol/index.ts` einen AJV‑Validator exportieren:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Server‑Verhalten**

Einen Handler in `src/gateway/server-methods/system.ts` hinzufügen:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

In `src/gateway/server-methods.ts` registrieren (führt bereits `systemHandlers` zusammen),
dann `"system.echo"` zu `METHODS` in `src/gateway/server.ts` hinzufügen.

4. **Neu generieren**

```bash
pnpm protocol:check
```

5. **Tests + Doku**

Einen Server‑Test in `src/gateway/server.*.test.ts` hinzufügen und die Methode in der Doku vermerken.

## Swift‑Codegenerierungsverhalten

Der Swift‑Generator erzeugt:

- Ein `GatewayFrame`‑Enum mit den Fällen `req`, `res`, `event` und `unknown`
- Stark typisierte Payload‑Structs/Enums
- `ErrorCode`‑Werte und `GATEWAY_PROTOCOL_VERSION`

Unbekannte Frame‑Typen werden als rohe Payloads beibehalten, um Vorwärtskompatibilität zu gewährleisten.

## Versionierung + Kompatibilität

- `PROTOCOL_VERSION` befindet sich in `src/gateway/protocol/schema.ts`.
- Clients senden `minProtocol` + `maxProtocol`; der Server lehnt Abweichungen ab.
- Die Swift‑Modelle behalten unbekannte Frame‑Typen bei, um ältere Clients nicht zu brechen.

## Schema‑Patterns und Konventionen

- Die meisten Objekte verwenden `additionalProperties: false` für strikte Payloads.
- `NonEmptyString` ist der Standard für IDs sowie Methoden‑/Event‑Namen.
- Das Top‑Level‑`GatewayFrame` verwendet einen **Discriminator** auf `type`.
- Methoden mit Nebenwirkungen erfordern in der Regel ein `idempotencyKey` in den Parametern
  (Beispiel: `send`, `poll`, `agent`, `chat.send`).

## Live‑Schema‑JSON

Das generierte JSON Schema befindet sich im Repo unter `dist/protocol.schema.json`. Die
veröffentlichte Raw‑Datei ist typischerweise verfügbar unter:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Wenn Sie Schemas ändern

1. Aktualisieren Sie die TypeBox‑Schemas.
2. Führen Sie `pnpm protocol:check` aus.
3. Committen Sie das neu generierte Schema + die Swift‑Modelle.
