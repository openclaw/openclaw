# Архитектура расширения MAX Messenger для OpenClaw

## Обзор

Расширение MAX Messenger интегрирует мессенджер MAX (суперприложение от VK Group) в платформу OpenClaw в качестве полноценного канала доставки сообщений. Архитектура следует паттерну `ChannelPlugin`, реализованному для других каналов (Telegram, Discord, Signal, Slack) и состоит из двух слоёв: **расширение** (extensions/max/) и **адаптер среды выполнения** (src/max/).

```
                           OpenClaw Gateway
                          +------------------+
                          |                  |
  MAX Bot API             |   Plugin Loader  |
  platform-api.max.ru     |        |         |
       ^                  |        v         |
       |                  |  Plugin Registry |
       |                  |        |         |
       |  HTTP/Polling    |        v         |
       +------ src/max/ --+-- extensions/max |
               (runtime)  |   (ChannelPlugin)|
                          |        |         |
                          |        v         |
                          |  Channel Manager |
                          |  (per-account)   |
                          +------------------+
```

---

## Компоненты

### 1. Расширение (extensions/max/)

Расширение реализует интерфейс `ChannelPlugin<ResolvedMaxAccount, MaxProbe>` и отвечает за бизнес-логику канала.

| Файл                   | Назначение                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Точка входа плагина. Регистрирует плагин в OpenClaw через `api.registerChannel()` и сохраняет ссылку на PluginRuntime                                                                       |
| `openclaw.plugin.json` | Манифест плагина: `id: "max"`, `channels: ["max"]`                                                                                                                                          |
| `package.json`         | NPM-пакет `@openclaw/max` (2026.2.16), `type: "module"`                                                                                                                                     |
| `src/channel.ts`       | Основной объект ChannelPlugin с 14+ секциями (meta, capabilities, messaging, pairing, config, security, groups, streaming, reload, setup, directory, status, outbound, gateway, onboarding) |
| `src/types.ts`         | TypeScript-интерфейсы: `MaxProbe`, `MaxAccountConfig`, `MaxConfig`, `ResolvedMaxAccount`                                                                                                    |
| `src/config-schema.ts` | Zod-схема валидации конфигурации (`MaxConfigSchema`)                                                                                                                                        |
| `src/accounts.ts`      | Разрешение аккаунтов: `resolveMaxAccount`, `listMaxAccountIds`, `resolveDefaultMaxAccountId`                                                                                                |
| `src/normalize.ts`     | Нормализация идентификаторов: `looksLikeMaxTargetId`, `normalizeMaxMessagingTarget`                                                                                                         |
| `src/runtime.ts`       | Синглтон PluginRuntime: `setMaxRuntime` / `getMaxRuntime`                                                                                                                                   |
| `src/onboarding.ts`    | Интерактивный мастер настройки `maxOnboardingAdapter`                                                                                                                                       |

### 2. Адаптер среды выполнения (src/max/)

Адаптер реализует низкоуровневое взаимодействие с MAX Bot API через HTTP.

| Файл                   | Назначение                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe.ts`             | `probeMax(token, timeoutMs, proxyUrl?)` — проверка токена через `GET /me` с 3 попытками                                                                                               |
| `send.ts`              | `sendMessageMax(chatId, text, opts)` — отправка текста через `POST /messages`. `sendMediaMax(chatId, buffer, opts)` — двухшаговая загрузка медиа (`POST /uploads` + `POST /messages`) |
| `monitor.ts`           | `monitorMaxProvider(opts)` — long polling через `@maxhub/max-bot-api` Bot или webhook-подписка через `POST /subscriptions`                                                            |
| `retry-policy.test.ts` | Тесты retry-runner для MAX                                                                                                                                                            |

### 3. Точки интеграции с платформой

Расширение MAX подключается к платформе OpenClaw через 6 точек интеграции:

| Точка интеграции     | Файл                           | Что делает                                                                                |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| **Реестр каналов**   | `src/channels/registry.ts`     | MAX — 2-й канал в `CHAT_CHANNEL_ORDER` (после Telegram). Метаданные в `CHAT_CHANNEL_META` |
| **Док канала**       | `src/channels/dock.ts`         | Capabilities, лимиты, streaming defaults, allowFrom resolution, group policies            |
| **PluginRuntime**    | `src/plugins/runtime/index.ts` | `channel.max` = { probeMax, sendMessageMax, sendMediaMax, monitorMaxProvider }            |
| **Markdown**         | `src/utils/message-channel.ts` | MAX включён в `MARKDOWN_CAPABLE_CHANNELS`                                                 |
| **Нативные команды** | `src/config/commands.ts`       | Автовключение нативных команд для MAX (как для Telegram и Discord)                        |
| **Документация**     | `docs/docs.json`               | Страница `channels/max` в сайдбаре Mintlify                                               |

---

## Жизненный цикл запуска канала

```
1. Gateway Start
   └─> loadOpenClawPlugins()
        └─> Обнаружение extensions/max/openclaw.plugin.json
             └─> Вызов register(api) из extensions/max/index.ts
                  ├─> setMaxRuntime(api.runtime)     // сохранить PluginRuntime
                  └─> api.registerChannel(maxPlugin)  // зарегистрировать ChannelPlugin

2. Channel Start
   └─> createChannelManager().startChannels()
        └─> Для каждого канала в listChannelPlugins()
             └─> startChannel("max")
                  └─> Для каждого accountId в listMaxAccountIds(cfg)
                       └─> maxPlugin.gateway.startAccount(ctx)
                            ├─> probeMax(token, 2500)         // проверка бота
                            └─> monitorMaxProvider(opts)       // запуск polling/webhook

3. Message Flow (inbound)
   └─> Bot.use(handler) получает update от MAX API
        └─> Gateway pipeline: identity → mention → pairing → route → reply

4. Message Flow (outbound)
   └─> maxPlugin.outbound.sendText(to, text, opts)
        └─> sendMessageMax(chatId, text, { format: "markdown", ... })
             └─> POST /messages?chat_id=... на platform-api.max.ru
```

---

## Модель данных

### Конфигурация (MaxConfig)

```
MaxConfig
 ├── enabled?: boolean
 ├── botToken?: string              // токен бота
 ├── tokenFile?: string             // путь к файлу с токеном
 ├── webhookUrl?: string            // URL для webhook
 ├── webhookSecret?: string         // секрет для X-Max-Bot-Api-Secret
 ├── dmPolicy?: "pairing" | "allowlist" | "open"
 ├── allowFrom?: (string | number)[]
 ├── groupPolicy?: "allowlist" | "open"
 ├── groupAllowFrom?: (string | number)[]
 ├── format?: "markdown" | "html"
 ├── textChunkLimit?: number
 ├── blockStreaming?: boolean
 ├── blockStreamingCoalesce?: { minChars, idleMs }
 ├── proxy?: string
 └── accounts?: Record<string, MaxAccountConfig>   // мультиаккаунт
```

### Разрешённый аккаунт (ResolvedMaxAccount)

```
ResolvedMaxAccount
 ├── accountId: string
 ├── enabled: boolean
 ├── name?: string
 ├── token: string                // итоговый токен (из config/file/env)
 ├── tokenSource: "env" | "tokenFile" | "config" | "none"
 └── config: MaxAccountConfig     // исходная конфигурация аккаунта
```

### Результат проверки (MaxProbe)

```
MaxProbe
 ├── ok: boolean
 ├── bot?: { id: number, name: string, username: string }
 └── error?: string
```

---

## Сетевая архитектура

### Long Polling (по умолчанию)

```
  OpenClaw Gateway              MAX Bot API
  +--------------+              +------------------+
  | Bot class    |  getUpdates  |                  |
  | (SDK)        | -----------> | platform-api     |
  |              | <----------- | .max.ru          |
  | handler(ctx) |   updates    |                  |
  +--------------+              +------------------+

  - Используется @maxhub/max-bot-api Bot class
  - Экспоненциальный backoff при ошибках (2s → 30s)
  - Автоматический рестарт после сбоя
```

### Webhook

```
  MAX Bot API                   OpenClaw Gateway
  +------------------+          +--------------+
  |                  |  POST    |              |
  | platform-api     | -------> | webhook      |
  | .max.ru          |  update  | receiver     |
  |                  |          |              |
  +------------------+          +--------------+

  - POST /subscriptions для подписки
  - X-Max-Bot-Api-Secret для верификации
  - DELETE /subscriptions при shutdown
```

### Отправка сообщений

```
  OpenClaw                      MAX Bot API
  +----------+                  +------------------+
  |          |  POST /messages  |                  |
  | send.ts  | ---------------> | platform-api     |
  |          |  (JSON body)     | .max.ru          |
  +----------+                  +------------------+

  Для медиа — двухшаговый процесс:
  1. POST /uploads?type=photo  (FormData с файлом)
  2. POST /messages            (JSON с attachment token)
```

---

## Retry и отказоустойчивость

Retry-логика реализована через `createMaxRetryRunner` (src/infra/retry-policy.ts):

| Параметр           | Значение                                                        |
| ------------------ | --------------------------------------------------------------- |
| Попытки            | 3                                                               |
| Мин. задержка      | 500 мс                                                          |
| Макс. задержка     | 30 000 мс                                                       |
| Jitter             | 15%                                                             |
| Повторяемые ошибки | 429, timeout, connect, reset, closed, unavailable, ECONNREFUSED |
| retry_after        | Парсится из тела ответа 429 (секунды → мс)                      |

Retry включается через опцию `retry` в `MaxSendOpts` — по умолчанию выключен (single-shot).

---

## Streaming (блочная отправка)

MAX поддерживает block streaming — механизм буферизации потоковых ответов AI-модели перед отправкой:

| Параметр         | Значение                               |
| ---------------- | -------------------------------------- |
| `blockStreaming` | `true`                                 |
| `minChars`       | 1500 символов (мин. размер блока)      |
| `idleMs`         | 1000 мс (flush после простоя)          |
| `textChunkLimit` | 4000 символов (макс. размер сообщения) |

Конвейер: AI-модель генерирует текст -> BlockReplyCoalescer накапливает -> при достижении minChars или idleMs -> BlockReplyPipeline отправляет через sendMessageMax.

---

## Покрытие тестами

| Файл                                       | Тестов  | Область                    |
| ------------------------------------------ | ------- | -------------------------- |
| `extensions/max/src/normalize.test.ts`     | 15      | Нормализация ID            |
| `extensions/max/src/accounts.test.ts`      | 14      | Разрешение аккаунтов       |
| `extensions/max/src/config-schema.test.ts` | 22      | Валидация Zod-схемы        |
| `extensions/max/src/channel.test.ts`       | 31      | Секции ChannelPlugin       |
| `src/max/probe.test.ts`                    | 8       | Проверка /me               |
| `src/max/send.test.ts`                     | 18      | Отправка сообщений + retry |
| `src/max/monitor.test.ts`                  | 7       | Polling + webhook          |
| `src/max/retry-policy.test.ts`             | 5       | Retry runner               |
| **Итого**                                  | **120** |                            |
