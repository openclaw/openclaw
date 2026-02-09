---
summary: "План: добавить эндпоинт OpenResponses /v1/responses и корректно вывести из эксплуатации chat completions"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "План Gateway OpenResponses"
---

# План интеграции Gateway OpenResponses

## Контекст

Gateway OpenClaw в настоящее время предоставляет минимальный OpenAI-совместимый эндпоинт Chat Completions по адресу
`/v1/chat/completions` (см. [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses — это открытый стандарт инференса, основанный на OpenAI Responses API. Он предназначен
для агентных рабочих процессов и использует ввод на основе элементов, а также семантические события потоковой передачи. Спецификация OpenResponses
определяет `/v1/responses`, а не `/v1/chat/completions`.

## Цели

- Добавить эндпоинт `/v1/responses`, соответствующий семантике OpenResponses.
- Сохранить Chat Completions как слой совместимости, который легко отключить и со временем удалить.
- Стандартизировать валидацию и парсинг с помощью изолированных, переиспользуемых схем.

## Не цели

- Полное соответствие возможностям OpenResponses на первом этапе (изображения, файлы, размещённые инструменты).
- Замена внутренней логики выполнения агентов или оркестрации инструментов.
- Изменение существующего поведения `/v1/chat/completions` на первом этапе.

## Краткое резюме исследования

Источники: OpenAPI OpenResponses, сайт спецификации OpenResponses и публикация в блоге Hugging Face.

Выделенные ключевые моменты:

- `POST /v1/responses` принимает поля `CreateResponseBody`, такие как `model`, `input` (строка или
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` и
  `max_tool_calls`.
- `ItemParam` представляет собой дискриминируемое объединение:
  - элементы `message` с ролями `system`, `developer`, `user`, `assistant`
  - `function_call` и `function_call_output`
  - `reasoning`
  - `item_reference`
- Успешные ответы возвращают `ResponseResource` с элементами `object: "response"`, `status` и
  `output`.
- Потоковая передача использует семантические события, такие как:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Спецификация требует:
  - `Content-Type: text/event-stream`
  - `event:` должен совпадать с полем JSON `type`
  - терминальное событие должно быть литералом `[DONE]`
- Элементы рассуждений могут предоставлять `content`, `encrypted_content` и `summary`.
- Примеры HF включают `OpenResponses-Version: latest` в запросах (необязательный заголовок).

## Предлагаемая архитектура

- Добавить `src/gateway/open-responses.schema.ts`, содержащий только схемы Zod (без импортов Gateway).
- Добавить `src/gateway/openresponses-http.ts` (или `open-responses-http.ts`) для `/v1/responses`.
- Сохранить `src/gateway/openai-http.ts` без изменений как адаптер совместимости для legacy.
- Добавить конфиг `gateway.http.endpoints.responses.enabled` (по умолчанию `false`).
- Сохранить независимость `gateway.http.endpoints.chatCompletions.enabled`; разрешить
  отдельное включение и отключение обоих эндпоинтов.
- Выдавать предупреждение при запуске, когда Chat Completions включён, чтобы обозначить его статус legacy.

## Путь вывода Chat Completions из эксплуатации

- Поддерживать строгие границы модулей: никаких общих типов схем между responses и chat completions.
- Сделать Chat Completions опциональным через конфигурацию, чтобы его можно было отключить без изменений кода.
- Обновить документацию, пометив Chat Completions как legacy после стабилизации `/v1/responses`.
- Необязательный будущий шаг: сопоставлять запросы Chat Completions с обработчиком Responses для более простого
  пути удаления.

## Поддерживаемое подмножество (Фаза 1)

- Принимать `input` как строку или `ItemParam[]` с ролями сообщений и `function_call_output`.
- Извлекать системные и developer-сообщения в `extraSystemPrompt`.
- Использовать самый последний `user` или `function_call_output` в качестве текущего сообщения для запусков агента.
- Отклонять неподдерживаемые части контента (image/file) с `invalid_request_error`.
- Возвращать одно сообщение ассистента с контентом `output_text`.
- Возвращать `usage` с нулевыми значениями до подключения учёта токенов.

## Стратегия валидации (без SDK)

- Реализовать схемы Zod для поддерживаемого подмножества:
  - `CreateResponseBody`
  - `ItemParam` + объединения частей контента сообщений
  - `ResponseResource`
  - Формы событий потоковой передачи, используемые Gateway
- Хранить схемы в одном изолированном модуле, чтобы избежать расхождений и упростить будущую генерацию кода.

## Реализация потоковой передачи (Фаза 1)

- Строки SSE с `event:` и `data:`.
- Обязательная последовательность (минимально жизнеспособная):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (повторять при необходимости)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## План тестирования и верификации

- Добавить e2e-покрытие для `/v1/responses`:
  - Требуется аутентификация
  - Форма нестримингового ответа
  - Порядок событий стрима и `[DONE]`
  - Маршрутизация сессий с заголовками и `user`
- Сохранить `src/gateway/openai-http.e2e.test.ts` без изменений.
- Ручное тестирование: curl к `/v1/responses` с `stream: true` и проверка порядка событий и терминального
  `[DONE]`.

## Обновления документации (после)

- Добавить новую страницу документации по использованию и примерам `/v1/responses`.
- Обновить `/gateway/openai-http-api`, добавив пометку legacy и ссылку на `/v1/responses`.
