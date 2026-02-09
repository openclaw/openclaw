---
summary: "Предоставить OpenAI-совместимую HTTP‑конечную точку /v1/chat/completions из Gateway (шлюза)"
read_when:
  - Интеграция инструментов, которые ожидают OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Gateway (шлюз) OpenClaw может предоставлять небольшой OpenAI‑совместимый endpoint Chat Completions.

Этот endpoint **по умолчанию отключён**. Сначала включите его в конфигурации.

- `POST /v1/chat/completions`
- Тот же порт, что и у Gateway (шлюза) (мультиплекс WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

Внутри запросы выполняются как обычный запуск агента Gateway (шлюза) (тот же кодовый путь, что и `openclaw agent`), поэтому маршрутизация/права доступа/конфигурация соответствуют вашему Gateway (шлюзу).

## Аутентификация

Использует конфигурацию аутентификации Gateway (шлюза). Отправьте bearer‑токен:

- `Authorization: Bearer <token>`

Примечания:

- Когда `gateway.auth.mode="token"`, используйте `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`).
- Когда `gateway.auth.mode="password"`, используйте `gateway.auth.password` (или `OPENCLAW_GATEWAY_PASSWORD`).

## Выбор агента

Пользовательские заголовки не требуются: закодируйте идентификатор агента в поле OpenAI `model`:

- `model: "openclaw:<agentId>"` (пример: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (псевдоним)

Или нацельтесь на конкретного агента OpenClaw с помощью заголовка:

- `x-openclaw-agent-id: <agentId>` (по умолчанию: `main`)

Дополнительно:

- `x-openclaw-session-key: <sessionKey>` для полного контроля маршрутизации сеансов.

## Включение endpoint

Установите `gateway.http.endpoints.chatCompletions.enabled` в `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Отключение endpoint

Установите `gateway.http.endpoints.chatCompletions.enabled` в `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Поведение сеансов

По умолчанию endpoint **не сохраняет состояние между запросами** (для каждого вызова генерируется новый ключ сеанса).

Если запрос включает строку OpenAI `user`, Gateway (шлюз) выводит из неё стабильный ключ сеанса, так что повторные вызовы могут совместно использовать сеанс агента.

## Потоковая передача (SSE)

Установите `stream: true`, чтобы получать Server‑Sent Events (SSE):

- `Content-Type: text/event-stream`
- Каждая строка события — `data: <json>`
- Поток завершается `data: [DONE]`

## Примеры

Без потоковой передачи:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Стриминг:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
