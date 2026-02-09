---
summary: "Используйте унифицированный API OpenRouter для доступа ко многим моделям в OpenClaw"
read_when:
  - Вам нужен один ключ API для многих LLM
  - Вы хотите запускать модели через OpenRouter в OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter предоставляет **унифицированный API**, который маршрутизирует запросы ко многим моделям за
одной конечной точкой и одним ключом API. Он совместим с OpenAI, поэтому большинство SDK OpenAI
работают при простой смене базового URL.

## Настройка CLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Фрагмент конфига

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Примечания

- Ссылки на модели — `openrouter/<provider>/<model>`.
- Дополнительные параметры моделей и провайдеров см. в [/concepts/model-providers](/concepts/model-providers).
- OpenRouter использует Bearer‑токен с вашим ключом API под капотом.
