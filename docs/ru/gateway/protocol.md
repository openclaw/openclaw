---
summary: "Протокол WebSocket Gateway: рукопожатие, фреймы, версионирование"
read_when:
  - Реализация или обновление клиентов WS шлюза
  - Отладка несоответствий протокола или сбоев подключения
  - Повторная генерация схем/моделей протокола
title: "Протокол Gateway"
---

# Протокол Gateway (WebSocket)

WS‑протокол Gateway — это **единая плоскость управления + транспорт узлов** для
OpenClaw. Все клиенты (CLI, веб‑интерфейс, приложение для macOS, узлы iOS/Android,
headless‑узлы) подключаются по WebSocket и объявляют свою **роль** и **область**
во время рукопожатия.

## Транспорт

- WebSocket, текстовые фреймы с полезной нагрузкой JSON.
- Первый фрейм **обязательно** должен быть запросом `connect`.

## Рукопожатие (подключение)

Gateway → Клиент (предварительный challenge перед подключением):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Клиент → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → Клиент:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Когда выдаётся токен устройства, `hello-ok` также включает:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Пример узла

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Фрейминг

- **Запрос**: `{type:"req", id, method, params}`
- **Ответ**: `{type:"res", id, ok, payload|error}`
- **Событие**: `{type:"event", event, payload, seq?, stateVersion?}`

Методы с побочными эффектами требуют **ключей идемпотентности** (см. схему).

## Роли и области действия

### Роли

- `operator` = клиент плоскости управления (CLI/UI/автоматизация).
- `node` = хост возможностей (камера/экран/канвас/system.run).

### Области (оператор)

Распространённые области:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Возможности/команды/права (узел)

Узлы объявляют заявления о возможностях при подключении:

- `caps`: высокоуровневые категории возможностей.
- `commands`: список разрешённых команд для invoke.
- `permissions`: детальные переключатели (например, `screen.record`, `camera.capture`).

Gateway рассматривает их как **claims** и применяет серверные allowlist‑ы.

## Присутствие

- `system-presence` возвращает записи, сгруппированные по идентификатору устройства.
- Записи присутствия включают `deviceId`, `roles` и `scopes`, чтобы интерфейсы могли показывать одну строку на устройство,
  даже когда оно подключается и как **оператор**, и как **узел**.

### Вспомогательные методы узла

- Узлы могут вызывать `skills.bins` для получения текущего списка исполняемых Skills
  для автоматических проверок разрешений.

## Утверждения Exec

- Когда запрос exec требует подтверждения, шлюз рассылает `exec.approval.requested`.
- Клиенты‑операторы разрешают его, вызывая `exec.approval.resolve` (требуется область `operator.approvals`).

## Versioning

- `PROTOCOL_VERSION` находится в `src/gateway/protocol/schema.ts`.
- Клиенты отправляют `minProtocol` и `maxProtocol`; сервер отклоняет несовпадения.
- Схемы и модели генерируются из определений TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Аутентификация

- Если задан `OPENCLAW_GATEWAY_TOKEN` (или `--token`), `connect.params.auth.token`
  должен совпадать, иначе сокет закрывается.
- После сопряжения Gateway выдаёт **токен устройства**, ограниченный ролью
  подключения и областями. Он возвращается в `hello-ok.auth.deviceToken` и должен
  сохраняться клиентом для будущих подключений.
- Токены устройств можно ротировать/отзывать через `device.token.rotate` и
  `device.token.revoke` (требуется область `operator.pairing`).

## Идентификация устройства и сопряжение

- Узлы должны включать стабильную идентичность устройства (`device.id`),
  производную от отпечатка ключевой пары.
- Gateways выдают токены на устройство и роль.
- Для новых идентификаторов устройств требуются подтверждения сопряжения,
  если не включено локальное авто‑подтверждение.
- **Локальные** подключения включают loopback и собственный адрес tailnet хоста шлюза
  (чтобы привязки tailnet на том же хосте всё ещё могли авто‑подтверждаться).
- Все WS‑клиенты должны включать идентичность `device` во время `connect`
  (оператор и узел).
  Контрольный UI может опустить её **только** когда включён `gateway.controlUi.allowInsecureAuth`
  (или `gateway.controlUi.dangerouslyDisableDeviceAuth` для экстренного доступа).
- Нелокальные подключения должны подписывать nonce `connect.challenge`, предоставленный сервером.

## TLS и пиннинг

- TLS поддерживается для WS‑подключений.
- Клиенты могут по желанию закреплять отпечаток сертификата шлюза (см. конфигурацию `gateway.tls`
  плюс `gateway.remote.tlsFingerprint` или CLI `--tls-fingerprint`).

## Область

Этот протокол предоставляет **полный API шлюза** (статус, каналы, модели, чат,
агент, сеансы, узлы, подтверждения и т. д.). Точная поверхность API определяется
схемами TypeBox в `src/gateway/protocol/schema.ts`.
