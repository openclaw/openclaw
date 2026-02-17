# Полная настройка OpenClaw через onboard wizard

> **Версия документа:** 1.0
> **Дата:** Февраль 2026

Пошаговая инструкция по настройке OpenClaw с Cloud.ru FM, AI Fabric (MCP), мессенджером и Brave Search.

Два варианта конфигурации:

| Конфиг | AI-бэкенд   | MCP       | Канал    | Веб-поиск    |
| ------ | ----------- | --------- | -------- | ------------ |
| **1**  | Cloud.ru FM | AI Fabric | Telegram | Brave Search |
| **2**  | Cloud.ru FM | AI Fabric | MAX      | Brave Search |

---

## Предварительные требования

| Компонент                            | Назначение               | Где получить                                          |
| ------------------------------------ | ------------------------ | ----------------------------------------------------- |
| Docker                               | Запуск Cloud.ru FM proxy | [docker.com](https://docker.com)                      |
| Cloud.ru API Key (`CLOUDRU_API_KEY`) | Аутентификация в FM API  | [cloud.ru](https://cloud.ru/ru/ai-foundation-models)  |
| Cloud.ru AI Fabric Project ID        | MCP auto-discovery       | Консоль Cloud.ru Evolution                            |
| Brave Search API Key                 | Веб-поиск                | [brave.com/search/api](https://brave.com/search/api/) |
| **Конфиг 1:** Telegram Bot Token     | Канал Telegram           | [@BotFather](https://t.me/BotFather)                  |
| **Конфиг 2:** MAX Bot Token          | Канал MAX                | [dev.max.ru](https://dev.max.ru)                      |

> **Важно:** Для Brave Search нужен план **"Data for Search"**, а НЕ "Data for AI".

---

## Часть A: Интерактивный онбординг (wizard)

```bash
pnpm openclaw onboard
```

### Шаг 1: Security warning

Прочитайте предупреждение о безопасности и подтвердите:

```
? I understand this is powerful... → Yes
```

### Шаг 2: Onboarding mode

Выберите **QuickStart** (по умолчанию):

```
? Onboarding mode:
  ▸ QuickStart
    Custom
```

### Шаг 3: Auth choice

В списке провайдеров выберите группу **Cloud.ru FM**, затем конкретную модель:

```
? Choose auth provider:
  ...
  ▸ Cloud.ru FM
      GLM-4.7-Flash (Free)   — бесплатный tier, все 3 уровня на GLM-4.7-Flash
      GLM-4.7 (Full)         — 358B MoE, thinking mode, 200K context
      Qwen3-Coder-480B       — оптимизирован для кода, 128K context
```

| Пресет               | CLI-флаг           | Описание                            |
| -------------------- | ------------------ | ----------------------------------- |
| GLM-4.7-Flash (Free) | `cloudru-fm-flash` | Бесплатно. Рекомендуется для начала |
| GLM-4.7 (Full)       | `cloudru-fm-glm47` | Лучшее качество. Для сложных задач  |
| Qwen3-Coder-480B     | `cloudru-fm-qwen`  | Специализирован для кодогенерации   |

### Шаг 4: Cloud.ru API Key

Введите API-ключ, когда wizard попросит:

```
? Enter your Cloud.ru API key: sk-xxxxxxxxxxxxxxxx
```

Или задайте заранее через переменную окружения:

```bash
export CLOUDRU_API_KEY="sk-xxxxxxxxxxxxxxxx"
```

### Шаг 5: Docker proxy auto-start

Wizard предложит запустить Docker proxy автоматически:

```
? Start Cloud.ru FM proxy (Docker)? → Yes
```

Дождитесь healthy статуса прокси. Wizard создаст `docker-compose.cloudru-proxy.yml` и запустит контейнер.

### Шаг 6: AI Fabric (MCP auto-discovery)

```
? Connect AI Fabric MCP servers? → Yes
? Enter AI Fabric Project ID: YOUR_PROJECT_ID
```

Wizard обнаружит доступные MCP-серверы и предложит выбрать нужные (multiselect):

```
? Select MCP servers to connect:
  ◉ managed-rag-server
  ◉ code-analysis-server
  ◯ experimental-server
```

Результат:

- Файл `claude-mcp-cloudru.json` создан автоматически
- Флаги `--mcp-config` и `--strict-mcp-config` добавлены в аргументы claude-cli

### Шаг 7: Default model

Wizard может предложить выбрать модель по умолчанию — оставьте рекомендованную.

### Шаг 8: Gateway config

QuickStart автоматически настраивает:

| Параметр | Значение             |
| -------- | -------------------- |
| Port     | 18789                |
| Bind     | 127.0.0.1 (loopback) |
| Auth     | Token                |

### Шаг 9: Выбор канала

**Конфиг 1 — Telegram:**

```
? Select channel (QuickStart): → Telegram
```

Wizard покажет инструкцию для получения токена через @BotFather.

```
? Enter Telegram Bot Token: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
? Telegram allowFrom (username or numeric ID): your_username
```

**Конфиг 2 — MAX:**

```
? Select channel (QuickStart): → MAX
```

Wizard покажет инструкцию (dev.max.ru).

```
? Enter MAX Bot Token: your-max-bot-token
```

### Шаг 10: Skills

```
? Configure skills now? → Yes (рекомендуется)
```

Wizard покажет список доступных skills и установит выбранные.

### Шаг 11: Finalize

- Wizard предложит установить daemon (systemd service) — по желанию
- Будет выполнен health check

---

## Часть B: Настройка Brave Search (после onboarding)

Brave Search **не входит** в основной `onboard` wizard. Настройте отдельно.

### Способ 1: Интерактивный wizard

```bash
pnpm openclaw configure --section web
```

```
? Enable web_search (Brave Search)? → Yes
? Enter Brave Search API key: BSA_YOUR_KEY_HERE
? Enable web_fetch (keyless HTTP fetch)? → Yes (рекомендуется)
```

### Способ 2: Ручное редактирование конфига

Добавить в `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "brave",
        "apiKey": "BSA_YOUR_KEY_HERE"
      },
      "fetch": {
        "enabled": true
      }
    }
  }
}
```

### Способ 3: Переменная окружения

```bash
export BRAVE_API_KEY="BSA_YOUR_KEY_HERE"
```

> Значение из конфига имеет приоритет над переменной окружения.

---

## Часть C: Non-interactive установка (одной командой)

### Конфиг 1 (Telegram)

```bash
export CLOUDRU_API_KEY="your-cloudru-api-key"
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export BRAVE_API_KEY="BSA_YOUR_KEY_HERE"

pnpm openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice cloudru-fm-flash \
  --cloudru-project-id "YOUR_PROJECT_ID" \
  --skip-skills
```

Затем настройте Brave Search:

```bash
pnpm openclaw configure --section web
```

### Конфиг 2 (MAX)

```bash
export CLOUDRU_API_KEY="your-cloudru-api-key"
export MAX_BOT_TOKEN="your-max-bot-token"
export BRAVE_API_KEY="BSA_YOUR_KEY_HERE"

pnpm openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice cloudru-fm-flash \
  --cloudru-project-id "YOUR_PROJECT_ID" \
  --skip-skills
```

Затем настройте Brave Search:

```bash
pnpm openclaw configure --section web
```

> **Примечание:** Non-interactive mode не поддерживает выбор канала автоматически — канал определяется из env vars. `TELEGRAM_BOT_TOKEN` или `MAX_BOT_TOKEN` будут обнаружены автоматически при следующем `openclaw configure --section channels`.

---

## Часть D: Проверка

```bash
# Проверить конфигурацию
pnpm openclaw doctor

# Проверить статус прокси
pnpm openclaw proxy status

# Проверить здоровье gateway
pnpm openclaw health

# Проверить каналы
pnpm openclaw channels status
```

### Итоговый `openclaw.json`

После полной настройки конфиг должен содержать:

```json5
{
  // Cloud.ru FM модели
  models: {
    providers: {
      "cloudru-fm": {
        /* ... */
      },
    },
  },

  // Claude CLI с proxy URL и MCP
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          // proxy URL + --mcp-config + --strict-mcp-config
        },
      },
    },
  },

  // AI Fabric
  aiFabric: {
    enabled: true,
    projectId: "YOUR_PROJECT_ID",
  },

  // Канал (один из двух)
  channels: {
    telegram: { botToken: "..." }, // Конфиг 1
    // или
    max: { botToken: "..." }, // Конфиг 2
  },

  // Brave Search
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: "BSA_...",
      },
    },
  },
}
```

---

## Диагностика

| Проблема                             | Причина                             | Решение                                                   |
| ------------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| Proxy не запускается                 | Docker не установлен или не запущен | `docker ps` — проверить Docker                            |
| "Cloud.ru FM proxy is not reachable" | Контейнер упал                      | `docker compose -f docker-compose.cloudru-proxy.yml logs` |
| 401 Unauthorized                     | Неверный API-ключ                   | Проверить `CLOUDRU_API_KEY`                               |
| MCP серверы не найдены               | Неверный Project ID                 | Проверить ID в консоли Cloud.ru                           |
| Telegram бот не отвечает             | Неверный токен или allowFrom        | Проверить токен через @BotFather                          |
| MAX бот не отвечает                  | Неверный токен                      | Проверить токен на dev.max.ru                             |
| "missing_brave_api_key"              | Не настроен Brave Search            | `openclaw configure --section web`                        |
| Ошибки tool calling                  | Нестабильность модели               | Переключиться на `cloudru-fm-flash`                       |

### Логи

```bash
# Логи прокси
docker compose -f docker-compose.cloudru-proxy.yml logs -f

# Логи gateway
pnpm openclaw logs --follow
```

---

## Ссылки

- [Cloud.ru Foundation Models](https://cloud.ru/ru/ai-foundation-models)
- [Cloud.ru AI Fabric](https://cloud.ru/products/evolution-ai-factory)
- [Brave Search API](https://brave.com/search/api/)
- [Telegram BotFather](https://t.me/BotFather)
- [MAX Developer Portal](https://dev.max.ru)
- [Установка Cloud.ru FM](foundation-models/installation.md)
- [Установка AI Fabric](ai-fabric/installation.md)
- [Установка MAX Messenger](max-messenger/installation.md)
