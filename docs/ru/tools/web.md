---
summary: "Инструменты веб-поиска и загрузки (Brave Search API, Perplexity напрямую/OpenRouter)"
read_when:
  - Вы хотите включить web_search или web_fetch
  - Вам нужна настройка ключа Brave Search API
  - Вы хотите использовать Perplexity Sonar для веб-поиска
title: "Веб-инструменты"
---

# Веб-инструменты

OpenClaw поставляется с двумя лёгкими веб-инструментами:

- `web_search` — Поиск в интернете через Brave Search API (по умолчанию) или Perplexity Sonar (напрямую или через OpenRouter).
- `web_fetch` — HTTP-загрузка + извлечение читаемого содержимого (HTML → markdown/текст).

Это **не** автоматизация браузера. Для сайтов с активным JavaScript или авторизацией используйте
[Browser tool](/tools/browser).

## Как это работает

- `web_search` обращается к настроенному провайдеру и возвращает результаты.
  - **Brave** (по умолчанию): возвращает структурированные результаты (заголовок, URL, сниппет).
  - **Perplexity**: возвращает ИИ-синтезированные ответы с цитированием из веб-поиска в реальном времени.
- Результаты кэшируются по запросу на 15 минут (настраивается).
- `web_fetch` выполняет обычный HTTP GET и извлекает читаемое содержимое
  (HTML → markdown/текст). JavaScript **не** выполняется.
- `web_fetch` включён по умолчанию (если явно не отключён).

## Выбор провайдера поиска

| Провайдер                                   | Плюсы                                                  | Психи                                      | Ключ API                                      |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------- |
| **Brave** (по умолчанию) | Быстро, структурированные результаты, бесплатный тариф | Классические результаты поиска             | `BRAVE_API_KEY`                               |
| **Perplexity**                              | ИИ-синтезированные ответы, цитирование, реальное время | Требуется доступ Perplexity или OpenRouter | `OPENROUTER_API_KEY` или `PERPLEXITY_API_KEY` |

[настройку Brave Search](/brave-search) и [Perplexity Sonar](/perplexity) для деталей по провайдерам.

Задайте провайдера в конфиге:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Пример: переключение на Perplexity Sonar (прямой API):

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

## Получение ключа Brave API

1. Создайте аккаунт Brave Search API на [https://brave.com/search/api/](https://brave.com/search/api/)
2. В панели управления выберите план **Data for Search** (не «Data for AI») и сгенерируйте ключ API.
3. Запустите `openclaw configure --section web`, чтобы сохранить ключ в конфиге (рекомендуется), либо задайте `BRAVE_API_KEY` в переменных окружения.

Brave предоставляет бесплатный тариф и платные планы; актуальные лимиты и цены смотрите в портале Brave API.

### Где задавать ключ (рекомендуется)

**Рекомендуется:** выполнить `openclaw configure --section web`. Это сохранит ключ в
`~/.openclaw/openclaw.json` в разделе `tools.web.search.apiKey`.

**Альтернатива через окружение:** задайте `BRAVE_API_KEY` в окружении процесса Gateway (шлюз). Для установки шлюза укажите его в `~/.openclaw/.env` (или в окружении сервиса). См. [переменные окружения](/help/faq#how-does-openclaw-load-environment-variables).

## Использование Perplexity (напрямую или через OpenRouter)

Модели Perplexity Sonar имеют встроенные возможности веб-поиска и возвращают ИИ-синтезированные
ответы с цитированием. Их можно использовать через OpenRouter (кредитная карта не требуется —
поддерживаются криптовалюта/предоплата).

### Получение ключа API OpenRouter

1. Создайте аккаунт на [https://openrouter.ai/](https://openrouter.ai/)
2. Пополните баланс (поддерживаются криптовалюта, предоплата или банковская карта)
3. Сгенерируйте ключ API в настройках аккаунта

### Настройка поиска Perplexity

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Альтернатива через окружение:** задайте `OPENROUTER_API_KEY` или `PERPLEXITY_API_KEY` в окружении Gateway (шлюз). Для установки шлюза укажите его в `~/.openclaw/.env`.

Если базовый URL не задан, OpenClaw выбирает значение по умолчанию в зависимости от источника ключа API:

- `PERPLEXITY_API_KEY` или `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` или `sk-or-...` → `https://openrouter.ai/api/v1`
- Неизвестные форматы ключей → OpenRouter (безопасный вариант)

### Доступные модели Perplexity

| Модель                                                   | Описание                               | Лучше всего подходит для |
| -------------------------------------------------------- | -------------------------------------- | ------------------------ |
| `perplexity/sonar`                                       | Быстрые вопросы и ответы с веб-поиском | Быстрых запросов         |
| `perplexity/sonar-pro` (по умолчанию) | Многошаговое рассуждение с веб-поиском | Сложных вопросов         |
| `perplexity/sonar-reasoning-pro`                         | Анализ с цепочкой рассуждений          | Глубокого исследования   |

## web_search

Поиск в интернете с использованием настроенного провайдера.

### Требования

- `tools.web.search.enabled` не должен быть `false` (по умолчанию: включено)
- Ключ API для выбранного провайдера:
  - **Brave**: `BRAVE_API_KEY` или `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` или `tools.web.search.perplexity.apiKey`

### Конфигурация

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Параметры инструмента

- `query` (обязательно)
- `count` (1–10; по умолчанию из конфига)
- `country` (необязательно): двухбуквенный код страны для региональных результатов (например, «DE», «US», «ALL»). Если не указано, Brave выбирает регион по умолчанию.
- `search_lang` (необязательно): ISO-код языка для результатов поиска (например, «de», «en», «fr»)
- `ui_lang` (необязательно): ISO-код языка для элементов интерфейса
- `freshness` (необязательно, только Brave): фильтр по времени обнаружения (`pd`, `pw`, `pm`, `py` или `YYYY-MM-DDtoYYYY-MM-DD`)

**Примеры:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Загрузка URL и извлечение читаемого содержимого.

### Требования web_fetch

- `tools.web.fetch.enabled` не должен быть `false` (по умолчанию: включено)
- Необязательный резервный вариант Firecrawl: задайте `tools.web.fetch.firecrawl.apiKey` или `FIRECRAWL_API_KEY`.

### Конфигурация web_fetch

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### Параметры инструмента web_fetch

- `url` (обязательно, только http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (обрезка длинных страниц)

Примечания:

- `web_fetch` сначала использует Readability (извлечение основного контента), затем Firecrawl (если настроен). Если оба варианта не сработают, инструмент вернёт ошибку.
- Запросы Firecrawl используют режим обхода ботов и по умолчанию кэшируют результаты.
- `web_fetch` отправляет User-Agent, похожий на Chrome, и `Accept-Language` по умолчанию; при необходимости переопределите `userAgent`.
- `web_fetch` блокирует приватные/внутренние имена хостов и повторно проверяет редиректы (ограничение через `maxRedirects`).
- `maxChars` ограничивается значением `tools.web.fetch.maxCharsCap`.
- `web_fetch` — извлечение «best-effort»; для некоторых сайтов потребуется инструмент браузера.
- См. [Firecrawl](/tools/firecrawl) для настройки ключей и деталей сервиса.
- Ответы кэшируются (по умолчанию 15 минут), чтобы сократить повторные загрузки.
- Если вы используете профили инструментов/списки разрешённых, добавьте `web_search`/`web_fetch` или `group:web`.
- Если ключ Brave отсутствует, `web_search` возвращает краткую подсказку по настройке со ссылкой на документацию.
