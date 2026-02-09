---
summary: "Esquemas TypeBox como la única fuente de verdad para el protocolo del Gateway"
read_when:
  - Actualización de esquemas de protocolo o generación de código
title: "TypeBox"
---

# TypeBox como fuente de verdad del protocolo

Última actualización: 2026-01-10

TypeBox es una biblioteca de esquemas orientada a TypeScript. La usamos para definir el **protocolo WebSocket del Gateway** (handshake, solicitud/respuesta, eventos del servidor). Esos esquemas impulsan la **validación en tiempo de ejecución**, la **exportación a JSON Schema** y la **generación de código Swift** para la app de macOS. Una sola fuente de verdad; todo lo demás se genera.

Si desea el contexto de protocolo de mayor nivel, comience con
[Arquitectura del Gateway](/concepts/architecture).

## Modelo mental (30 segundos)

Cada mensaje WS del Gateway es uno de tres marcos:

- **Solicitud**: `{ type: "req", id, method, params }`
- **Respuesta**: `{ type: "res", id, ok, payload | error }`
- **Evento**: `{ type: "event", event, payload, seq?, stateVersion? }`

El primer marco **debe** ser una solicitud `connect`. Después de eso, los clientes pueden llamar
métodos (p. ej., `health`, `send`, `chat.send`) y suscribirse a eventos (p. ej.,
`presence`, `tick`, `agent`).

Flujo de conexión (mínimo):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Métodos y eventos comunes:

| Categoría | Ejemplos                                                  | Notas                                              |
| --------- | --------------------------------------------------------- | -------------------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` debe ser primero                         |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | los efectos secundarios requieren `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat usa estos                                  |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | administración de sesiones                         |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | WS del Gateway + acciones de nodos                 |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | push del servidor                                  |

La lista autoritativa vive en `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Dónde viven los esquemas

- Fuente: `src/gateway/protocol/schema.ts`
- Validadores en tiempo de ejecución (AJV): `src/gateway/protocol/index.ts`
- Handshake del servidor + despacho de métodos: `src/gateway/server.ts`
- Cliente de nodo: `src/gateway/client.ts`
- JSON Schema generado: `dist/protocol.schema.json`
- Modelos Swift generados: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Pipeline actual

- `pnpm protocol:gen`
  - escribe JSON Schema (draft‑07) en `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - genera modelos del Gateway en Swift
- `pnpm protocol:check`
  - ejecuta ambos generadores y verifica que la salida esté confirmada

## Cómo se usan los esquemas en tiempo de ejecución

- **Lado del servidor**: cada marco entrante se valida con AJV. El handshake solo
  acepta una solicitud `connect` cuyos parámetros coincidan con `ConnectParams`.
- **Lado del cliente**: el cliente JS valida los marcos de eventos y respuestas antes de
  usarlos.
- **Superficie de métodos**: el Gateway anuncia los `methods` y
  `events` compatibles en `hello-ok`.

## Marcos de ejemplo

Conectar (primer mensaje):

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

Respuesta hello-ok:

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

Solicitud + respuesta:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Evento:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Cliente mínimo (Node.js)

Flujo útil más pequeño: conectar + health.

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

## Ejemplo trabajado: agregar un método de extremo a extremo

Ejemplo: agregar una nueva solicitud `system.echo` que devuelva `{ ok: true, text }`.

1. **Esquema (fuente de verdad)**

Agregar a `src/gateway/protocol/schema.ts`:

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

Agregar ambos a `ProtocolSchemas` y exportar tipos:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validación**

En `src/gateway/protocol/index.ts`, exportar un validador AJV:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Comportamiento del servidor**

Agregar un handler en `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Registrarlo en `src/gateway/server-methods.ts` (ya fusiona `systemHandlers`),
luego agregar `"system.echo"` a `METHODS` en `src/gateway/server.ts`.

4. **Regenerar**

```bash
pnpm protocol:check
```

5. **Pruebas + docs**

Agregar una prueba del servidor en `src/gateway/server.*.test.ts` y anotar el método en la documentación.

## Comportamiento de la generación de código Swift

El generador Swift emite:

- Enum `GatewayFrame` con los casos `req`, `res`, `event` y `unknown`
- Structs/enums de payload fuertemente tipados
- Valores `ErrorCode` y `GATEWAY_PROTOCOL_VERSION`

Los tipos de marco desconocidos se conservan como payloads sin procesar para compatibilidad futura.

## Versionado + compatibilidad

- `PROTOCOL_VERSION` vive en `src/gateway/protocol/schema.ts`.
- Los clientes envían `minProtocol` + `maxProtocol`; el servidor rechaza discrepancias.
- Los modelos Swift conservan tipos de marco desconocidos para evitar romper clientes antiguos.

## Patrones y convenciones de esquemas

- La mayoría de los objetos usan `additionalProperties: false` para payloads estrictos.
- `NonEmptyString` es el valor predeterminado para IDs y nombres de métodos/eventos.
- El `GatewayFrame` de nivel superior usa un **discriminador** en `type`.
- Los métodos con efectos secundarios suelen requerir un `idempotencyKey` en los parámetros
  (ejemplo: `send`, `poll`, `agent`, `chat.send`).

## JSON de esquemas en vivo

El JSON Schema generado está en el repositorio en `dist/protocol.schema.json`. El
archivo raw publicado suele estar disponible en:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Cuando cambie los esquemas

1. Actualice los esquemas TypeBox.
2. Ejecute `pnpm protocol:check`.
3. Confirme el esquema regenerado + los modelos Swift.
