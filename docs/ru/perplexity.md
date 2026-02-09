---
summary: "Настройка Perplexity Sonar для web_search"
read_when:
  - Вам нужно использовать Perplexity Sonar для веб-поиска
  - Вам нужен PERPLEXITY_API_KEY или настройка OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw может использовать Perplexity Sonar для инструмента `web_search`. Вы можете подключаться
через прямой API Perplexity или через OpenRouter.

## Варианты API

### Perplexity (напрямую)

- Базовый URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Переменная окружения: `PERPLEXITY_API_KEY`

### OpenRouter (альтернатива)

- Базовый URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Переменная окружения: `OPENROUTER_API_KEY`
- Поддерживает предоплаченные/криптовалютные кредиты.

## Пример конфига

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Переход с Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

Если заданы оба значения `PERPLEXITY_API_KEY` и `OPENROUTER_API_KEY`, установите
`tools.web.search.perplexity.baseUrl` (или `tools.web.search.perplexity.apiKey`)
для устранения неоднозначности.

Если базовый URL не задан, OpenClaw выбирает значение по умолчанию на основе источника ключа API:

- `PERPLEXITY_API_KEY` или `pplx-...` → прямой Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` или `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Неизвестные форматы ключей → OpenRouter (безопасный вариант по умолчанию)

## Модели

- `perplexity/sonar` — быстрые вопросы и ответы с веб-поиском
- `perplexity/sonar-pro` (по умолчанию) — многошаговые рассуждения + веб-поиск
- `perplexity/sonar-reasoning-pro` — глубокое исследование

[Web tools](/tools/web) для полной конфигурации web_search.
