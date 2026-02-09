---
summary: "Schematy TypeBox jako pojedyncze źródło prawdy dla protokołu Gateway"
read_when:
  - Aktualizacja schematów protokołu lub codegen
title: "TypeBox"
---

# TypeBox jako źródło prawdy protokołu

Ostatnia aktualizacja: 2026-01-10

TypeBox to biblioteka schematów zorientowana na TypeScript. Używamy jej do definiowania **protokołu WebSocket Gateway** (handshake, żądania/odpowiedzi, zdarzenia serwera). Te schematy napędzają **walidację w czasie działania**, **eksport JSON Schema** oraz **generowanie kodu Swift** dla aplikacji macOS. Jedno źródło prawdy; cała reszta jest generowana.

Jeśli potrzebujesz szerszego kontekstu protokołu, zacznij od
[Gateway architecture](/concepts/architecture).

## Model mentalny (30 sekund)

Każda wiadomość WS Gateway jest jedną z trzech ramek:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

Pierwszą ramką **musi** być żądanie `connect`. Następnie klienci mogą wywoływać
metody (np. `health`, `send`, `chat.send`) oraz subskrybować zdarzenia (np.
`presence`, `tick`, `agent`).

Przepływ połączenia (minimalny):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Typowe metody i zdarzenia:

| Kategoria | Przykłady                                                 | Uwagi                                    |
| --------- | --------------------------------------------------------- | ---------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` musi być pierwsze              |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | efekty uboczne wymagają `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat korzysta z nich                  |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | administracja sesjami                    |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | WS Gateway + akcje węzłów                |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | push serwera                             |

Autorytatywna lista znajduje się w `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Gdzie znajdują się schematy

- Źródło: `src/gateway/protocol/schema.ts`
- Walidatory runtime (AJV): `src/gateway/protocol/index.ts`
- Handshake serwera + dyspozycja metod: `src/gateway/server.ts`
- Klient węzła: `src/gateway/client.ts`
- Wygenerowany JSON Schema: `dist/protocol.schema.json`
- Wygenerowane modele Swift: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Aktualny pipeline

- `pnpm protocol:gen`
  - zapisuje JSON Schema (draft‑07) do `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - generuje modele Gateway w Swift
- `pnpm protocol:check`
  - uruchamia oba generatory i weryfikuje, że wynik jest zatwierdzony w repozytorium

## Jak schematy są używane w czasie działania

- **Po stronie serwera**: każda przychodząca ramka jest walidowana przez AJV. Handshake
  akceptuje wyłącznie żądanie `connect`, którego parametry pasują do `ConnectParams`.
- **Po stronie klienta**: klient JS waliduje ramki zdarzeń i odpowiedzi przed
  ich użyciem.
- **Powierzchnia metod**: Gateway ogłasza obsługiwane `methods` oraz
  `events` w `hello-ok`.

## Przykładowe ramki

Połączenie (pierwsza wiadomość):

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

Odpowiedź hello-ok:

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

Żądanie + odpowiedź:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Zdarzenie:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Minimalny klient (Node.js)

Najmniejszy użyteczny przepływ: połączenie + health.

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

## Przykład krok po kroku: dodanie metody end‑to‑end

Przykład: dodanie nowego żądania `system.echo`, które zwraca `{ ok: true, text }`.

1. **Schemat (źródło prawdy)**

Dodaj do `src/gateway/protocol/schema.ts`:

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

Dodaj oba do `ProtocolSchemas` i wyeksportuj typy:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Walidacja**

W `src/gateway/protocol/index.ts` wyeksportuj walidator AJV:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Zachowanie serwera**

Dodaj handler w `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Zarejestruj go w `src/gateway/server-methods.ts` (już scala `systemHandlers`),
a następnie dodaj `"system.echo"` do `METHODS` w `src/gateway/server.ts`.

4. **Regeneracja**

```bash
pnpm protocol:check
```

5. **Testy + dokumentacja**

Dodaj test serwera w `src/gateway/server.*.test.ts` i odnotuj metodę w dokumentacji.

## Zachowanie generowania kodu Swift

Generator Swift emituje:

- Enum `GatewayFrame` z przypadkami `req`, `res`, `event` oraz `unknown`
- Silnie typowane struktury/enumy payloadów
- Wartości `ErrorCode` oraz `GATEWAY_PROTOCOL_VERSION`

Nieznane typy ramek są zachowywane jako surowe payloady w celu kompatybilności w przód.

## Versioning + compatibility

- `PROTOCOL_VERSION` znajduje się w `src/gateway/protocol/schema.ts`.
- Klienci wysyłają `minProtocol` + `maxProtocol`; serwer odrzuca niezgodności.
- Modele Swift zachowują nieznane typy ramek, aby nie łamać starszych klientów.

## Wzorce i konwencje schematów

- Większość obiektów używa `additionalProperties: false` dla ścisłych payloadów.
- `NonEmptyString` jest domyślne dla identyfikatorów oraz nazw metod/zdarzeń.
- Najwyższego poziomu `GatewayFrame` używa **dyskryminatora** na `type`.
- Metody z efektami ubocznymi zwykle wymagają `idempotencyKey` w parametrach
  (przykład: `send`, `poll`, `agent`, `chat.send`).

## Aktywny JSON schematu

Wygenerowany JSON Schema znajduje się w repozytorium pod `dist/protocol.schema.json`. Opublikowany
surowy plik jest zazwyczaj dostępny pod:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Gdy zmieniasz schematy

1. Zaktualizuj schematy TypeBox.
2. Uruchom `pnpm protocol:check`.
3. Zatwierdź zregenerowany schemat oraz modele Swift.
