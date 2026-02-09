---
summary: "Задачи LLM только с JSON для рабочих процессов (необязательный плагин-инструмент)"
read_when:
  - Вам нужен шаг LLM только с JSON внутри рабочих процессов
  - Вам требуется вывод LLM, валидируемый по схеме, для автоматизации
title: "Задача LLM"
---

# Задача LLM

`llm-task` — это **необязательный плагин-инструмент**, который выполняет задачу LLM только с JSON и
возвращает структурированный вывод (опционально валидируемый по JSON Schema).

Это идеально подходит для движков рабочих процессов, таких как Lobster: вы можете добавить один шаг LLM
без написания пользовательского кода OpenClaw для каждого рабочего процесса.

## Включение плагина

1. Включите плагин:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Добавьте инструмент в список разрешённых (он зарегистрирован с `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## Конфигурация (необязательно)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` — это список разрешённых строк `provider/model`. Если задано, любой запрос
вне списка отклоняется.

## Параметры инструмента

- `prompt` (string, обязательно)
- `input` (any, необязательно)
- `schema` (object, необязательная JSON Schema)
- `provider` (string, необязательно)
- `model` (string, необязательно)
- `authProfileId` (string, необязательно)
- `temperature` (number, необязательно)
- `maxTokens` (number, необязательно)
- `timeoutMs` (number, необязательно)

## Вывод

Возвращает `details.json`, содержащий разобранный JSON (и выполняет валидацию по
`schema`, если она предоставлена).

## Пример: шаг рабочего процесса Lobster

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## Примечания по безопасности

- Инструмент работает **только с JSON** и инструктирует модель выводить исключительно JSON (без
  ограждений кода и без комментариев).
- Для этого запуска модели не предоставляются никакие инструменты.
- Считайте вывод недоверенным, если вы не выполняете проверку с помощью `schema`.
- Размещайте подтверждения перед любым шагом с побочными эффектами (send, post, exec).
