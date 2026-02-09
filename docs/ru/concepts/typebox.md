---
summary: "Схемы TypeBox как единственный источник истины для протокола Gateway"
read_when:
  - При обновлении схем протокола или codegen
title: "TypeBox"
---

# TypeBox как источник истины протокола

Последнее обновление: 2026-01-10

TypeBox — это библиотека схем с приоритетом TypeScript. Мы используем её для определения **протокола Gateway WebSocket** (рукопожатие, запрос/ответ, серверные события). Эти схемы управляют **валидацией во время выполнения**, **экспортом JSON Schema** и **генерацией Swift-кода** для приложения macOS. Один источник истины; всё остальное генерируется.

Если нужен более высокоуровневый контекст протокола, начните с
[архитектуры Gateway](/concepts/architecture).

## Ментальная модель (30 секунд)

Каждое WS‑сообщение Gateway — это один из трёх фреймов:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

Первым фреймом **обязательно** должен быть запрос `connect`. После этого клиенты могут вызывать
методы (например, `health`, `send`, `chat.send`) и подписываться на события (например,
`presence`, `tick`, `agent`).

Поток подключения (минимальный):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Общие методы и события:

| Категория | Примеры                                                   | Примечания                                |
| --------- | --------------------------------------------------------- | ----------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` должен быть первым              |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | побочные эффекты требуют `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat использует их                     |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | администрирование сеансов                 |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + действия узлов               |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | push от сервера                           |

Авторитетный список находится в `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Где живут схемы

- Исходники: `src/gateway/protocol/schema.ts`
- Валидаторы во время выполнения (AJV): `src/gateway/protocol/index.ts`
- Рукопожатие сервера + диспетчеризация методов: `src/gateway/server.ts`
- Клиент узла: `src/gateway/client.ts`
- Сгенерированная JSON Schema: `dist/protocol.schema.json`
- Сгенерированные Swift‑модели: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Текущий трубопровод

- `pnpm protocol:gen`
  - записывает JSON Schema (draft‑07) в `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - генерирует Swift‑модели Gateway
- `pnpm protocol:check`
  - запускает оба генератора и проверяет, что результат закоммичен

## Как схемы используются во время выполнения

- **Со стороны сервера**: каждый входящий фрейм валидируется AJV. Рукопожатие принимает
  только запрос `connect`, параметры которого соответствуют `ConnectParams`.
- **Со стороны клиента**: JS‑клиент валидирует фреймы событий и ответов перед
  их использованием.
- **Поверхность методов**: Gateway объявляет поддерживаемые `methods` и
  `events` в `hello-ok`.

## Примеры фреймов

Подключение (первое сообщение):

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

Ответ hello‑ok:

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

Запрос + ответ:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Событие:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Минимальный клиент (Node.js)

Минимально полезный поток: подключение + health.

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

## Проработанный пример: добавление метода end‑to‑end

Пример: добавить новый запрос `system.echo`, который возвращает `{ ok: true, text }`.

1. **Схема (источник истины)**

Добавьте в `src/gateway/protocol/schema.ts`:

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

Добавьте оба в `ProtocolSchemas` и экспортируйте типы:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Валидация**

В `src/gateway/protocol/index.ts` экспортируйте валидатор AJV:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Поведение сервера**

Добавьте обработчик в `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Зарегистрируйте его в `src/gateway/server-methods.ts` (уже объединяет `systemHandlers`),
затем добавьте `"system.echo"` в `METHODS` в `src/gateway/server.ts`.

4. **Перегенерация**

```bash
pnpm protocol:check
```

5. **Тесты и документация**

Добавьте серверный тест в `src/gateway/server.*.test.ts` и отметьте метод в документации.

## Поведение Swift‑codegen

Генератор Swift создаёт:

- enum `GatewayFrame` с кейсами `req`, `res`, `event` и `unknown`
- Строго типизированные структуры/enum для полезной нагрузки
- Значения `ErrorCode` и `GATEWAY_PROTOCOL_VERSION`

Неизвестные типы фреймов сохраняются как «сырые» полезные нагрузки для прямой совместимости.

## Версионирование и совместимость

- `PROTOCOL_VERSION` живёт в `src/gateway/protocol/schema.ts`.
- Клиенты отправляют `minProtocol` + `maxProtocol`; сервер отклоняет несовпадения.
- Swift‑модели сохраняют неизвестные типы фреймов, чтобы не ломать старые клиенты.

## Шаблоны схем и соглашения

- Большинство объектов используют `additionalProperties: false` для строгих полезных нагрузок.
- `NonEmptyString` используется по умолчанию для ID и имён методов/событий.
- Верхнеуровневый `GatewayFrame` использует **дискриминатор** по `type`.
- Методы с побочными эффектами обычно требуют `idempotencyKey` в параметрах
  (пример: `send`, `poll`, `agent`, `chat.send`).

## Живая JSON Schema

Сгенерированная JSON Schema находится в репозитории по адресу `dist/protocol.schema.json`. Опубликованный «сырой» файл обычно доступен по адресу:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Когда вы меняете схемы

1. Обновите схемы TypeBox.
2. Запустите `pnpm protocol:check`.
3. Закоммитьте перегенерированную схему и Swift‑модели.
