---
summary: "Открыть HTTP-эндпоинт /v1/responses, совместимый с OpenResponses, из Gateway"
read_when:
  - Интеграция клиентов, которые говорят по API OpenResponses
  - Вам нужны входы на основе items, клиентские вызовы инструментов или события SSE
title: "API OpenResponses"
---

# OpenResponses API (HTTP)

Gateway (шлюз) OpenClaw может обслуживать совместимый с OpenResponses эндпоинт `POST /v1/responses`.

Этот эндпоинт **по умолчанию отключён**. Сначала включите его в конфиге.

- `POST /v1/responses`
- Тот же порт, что и у Gateway (мультиплекс WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

Под капотом запросы выполняются как обычный запуск агента Gateway (тот же кодовый путь, что и
`openclaw agent`), поэтому маршрутизация/права доступа/конфигурация совпадают с вашим Gateway.

## Аутентификация

Используется конфигурация аутентификации Gateway. Отправляйте bearer-токен:

- `Authorization: Bearer <token>`

Примечания:

- Когда `gateway.auth.mode="token"`, используйте `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`).
- Когда `gateway.auth.mode="password"`, используйте `gateway.auth.password` (или `OPENCLAW_GATEWAY_PASSWORD`).

## Выбор агента

Пользовательские заголовки не требуются: закодируйте идентификатор агента в поле OpenResponses `model`:

- `model: "openclaw:<agentId>"` (пример: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (псевдоним)

Или нацельтесь на конкретного агента OpenClaw через заголовок:

- `x-openclaw-agent-id: <agentId>` (по умолчанию: `main`)

Дополнительно:

- `x-openclaw-session-key: <sessionKey>` для полного контроля маршрутизации сеансов.

## Включение endpoint

Установите `gateway.http.endpoints.responses.enabled` в `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Отключение эндпоинта

Установите `gateway.http.endpoints.responses.enabled` в `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Поведение сеансов

По умолчанию эндпоинт **не хранит состояние между запросами** (для каждого вызова генерируется новый ключ сеанса).

Если запрос включает строку OpenResponses `user`, Gateway выводит из неё стабильный ключ сеанса,
так что повторные вызовы могут разделять один и тот же сеанс агента.

## Форма запроса (поддерживается)

Запрос следует API OpenResponses с вводом на основе items. Текущая поддержка:

- `input`: строка или массив объектов items.
- `instructions`: объединяется с системным промптом.
- `tools`: определения клиентских инструментов (функциональные инструменты).
- `tool_choice`: фильтрация или требование клиентских инструментов.
- `stream`: включает потоковую передачу SSE.
- `max_output_tokens`: ограничение вывода «best-effort» (зависит от провайдера).
- `user`: стабильная маршрутизация сеанса.

Принимаются, но **в настоящее время игнорируются**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (ввод)

### `message`

Роли: `system`, `developer`, `user`, `assistant`.

- `system` и `developer` добавляются к системному промпту.
- Самый последний item `user` или `function_call_output` становится «текущим сообщением».
- Более ранние сообщения пользователя/ассистента включаются в историю для контекста.

### `function_call_output` (инструменты с пошаговыми ходами)

Отправляйте результаты инструментов обратно модели:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` и `item_reference`

Принимаются для совместимости со схемой, но игнорируются при построении промпта.

## Инструменты (клиентские функциональные инструменты)

Передавайте инструменты с помощью `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Если агент решает вызвать инструмент, ответ возвращает элемент вывода `function_call`.
Затем вы отправляете последующий запрос с `function_call_output`, чтобы продолжить ход.

## Изображения (`input_image`)

Поддерживаются источники base64 или URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Разрешённые MIME-типы (текущие): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Максимальный размер (текущий): 10MB.

## Файлы (`input_file`)

Поддерживаются источники base64 или URL:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Разрешённые MIME-типы (текущие): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Максимальный размер (текущий): 5MB.

Текущее поведение:

- Содержимое файла декодируется и добавляется в **системный промпт**, а не в сообщение пользователя,
  поэтому оно остаётся эфемерным (не сохраняется в истории сеанса).
- PDF разбираются на текст. Если текста найдено мало, первые страницы растеризуются
  в изображения и передаются модели.

Разбор PDF использует legacy-сборку `pdfjs-dist`, дружелюбную к Node (без worker). Современная
сборка PDF.js ожидает браузерные workers/DOM-глобалы, поэтому в Gateway не используется.

Параметры загрузки по URL по умолчанию:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Запросы защищены (разрешение DNS, блокировка приватных IP, ограничения на редиректы, тайм-ауты).

## Лимиты файлов и изображений (конфиг)

Значения по умолчанию можно настроить в разделе `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Значения по умолчанию при отсутствии указания:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Потоковая передача (SSE)

Установите `stream: true`, чтобы получать Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Каждая строка события — это `event: <type>` и `data: <json>`
- Поток завершается `data: [DONE]`

Типы событий, которые сейчас эмитятся:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (при ошибке)

## Использование

`usage` заполняется, когда базовый провайдер сообщает счётчики токенов.

## Ошибки

Ошибки используют JSON-объект вида:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Типичные случаи:

- `401` отсутствует/некорректная аутентификация
- `400` некорректное тело запроса
- `405` неверный метод

## Примеры

Без потоковой передачи:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Стриминг:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
