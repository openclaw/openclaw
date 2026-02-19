# OpenClaw Platform -- Функциональная документация

> Архитектура: DDD, Bounded Contexts | TypeScript | Точка входа: `src/index.ts`

## 1. Управление тенантами и сессиями

### 1.1 Агрегат UserTenant

Корневая сущность мультитенантной системы. `TenantIdString` формат: `{platform}:{userId}:{chatId}`.

Поля: `tenantId`, `platform` (`telegram|max|web|api`), `tier` (`free|standard|premium|admin`), `createdAt`, `lastActiveAt`, `suspended`, `workspacePath`.

| Функция                             | Описание                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| `createUserTenant(params)`          | Создание тенанта (tier=`free`, workspace=`/workspaces/{id}`) |
| `touchTenant(tenant)`               | Обновление `lastActiveAt`                                    |
| `changeTenantTier(tenant, newTier)` | Смена уровня доступа                                         |
| `suspendTenant(tenant)`             | Блокировка (`suspended=true`)                                |
| `reinstateTenant(tenant)`           | Восстановление доступа                                       |

Все операции иммутабельны -- возвращают новый объект.

### 1.2 Сущность TenantSession

Конечный автомат: `idle -> active -> processing -> active (цикл)`. Из любого состояния возможен переход в `suspended`. Из `active`/`processing` -- в `expired`.

| Из           | Допустимые переходы                  |
| ------------ | ------------------------------------ |
| `idle`       | `active`, `suspended`                |
| `active`     | `processing`, `expired`, `suspended` |
| `processing` | `active`, `expired`, `suspended`     |
| `expired`    | `suspended`                          |
| `suspended`  | -- (терминальное)                    |

| Функция                                                   | Описание                                    |
| --------------------------------------------------------- | ------------------------------------------- |
| `createTenantSession(sessionId, tenantId, ttlMs=3600000)` | Создание в состоянии `idle`, TTL 1 час      |
| `transitionSession(session, newState)`                    | Переход, возвращает `Result<TenantSession>` |
| `isSessionExpired(session, now?)`                         | Проверка TTL                                |
| `extendSession(session, extensionMs)`                     | Продление TTL                               |

`SessionIdString` -- детерминистически из TenantId: `session:{tenantId}`.

### 1.3 Уровни доступа

Иерархия: `free < standard < premium < admin`. Проверка: `isTierAtLeast(current, required)`.

| AccessTier | SandboxTier  | Инструменты                         | maxConcurrentTools | Одобрение |
| ---------- | ------------ | ----------------------------------- | :----------------: | :-------: |
| `free`     | `restricted` | Read, Glob, Grep, WebFetch          |         1          |    Да     |
| `standard` | `standard`   | + Write, Edit, NotebookEdit         |         2          |    Нет    |
| `premium`  | `full`       | + Bash, WebSearch, Skill, TodoWrite |         4          |    Нет    |
| `admin`    | `full`       | Все                                 |      Infinity      |    Нет    |

Хранилища: `ITenantStore`/`InMemoryTenantStore`, `ISessionStore`/`InMemorySessionStore`.

---

## 2. Управление рабочими пространствами

**WorkspaceManager** -- жизненный цикл workspace тенантов:

| Метод                          | Описание                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `provisionWorkspace(tenantId)` | Создает `/workspaces/{tenantId}`, генерирует `CLAUDE.md` |
| `cleanWorkspace(tenantId)`     | Удаляет workspace                                        |
| `validatePath(path, tenantId)` | Проверяет принадлежность пути к workspace                |

**Защита от Directory Traversal** (`validateWorkspacePath`, `validateTenantPath`):

- Путь абсолютный, начинается с `/workspaces/`
- Запрещены `..`, нормализация лишних `/` и `.`
- Проверка принадлежности к workspace тенанта

Зависимость: `IFileSystem` (`mkdir`, `writeFile`, `rmdir`, `exists`).

---

## 3. Многоплатформенный мессенджер

### 3.1 IMessengerPort

Единый интерфейс: `sendMessage`, `editMessage`, `deleteMessage`, `sendTypingIndicator`, `parseWebhook`, `validateWebhookSignature`.

### 3.2 Адаптеры

**TelegramAdapter** -- Telegram Bot API: `sendMessage`, `editMessageText`, `deleteMessage`, `sendChatAction`. HMAC-SHA256 валидация через `x-telegram-bot-api-secret-token` + `crypto.timingSafeEqual`. Настраиваемый `baseUrl`. Поддержка `MarkdownV2`/`HTML`.

**WebAdapter** -- in-memory хранилище (`Map<chatId, OutgoingMessage[]>`). API Key через `x-api-key`/`Authorization: Bearer`. Дополнительно: `getMessages(chatId)`, `clearMessages(chatId)`.

### 3.3 WebhookRouter

Регистрация: `register(platform, adapter, webhookSecret)`. Маршрутизация: `route(payload)` -- валидация подписи, парсинг, эмиссия событий. При ошибке -- `messenger.webhook.validation_failed`.

### 3.4 MessageDispatcher

Извлечение платформы из `tenantId` через `parseTenantId()`, разрешение адаптера, отправка. Эмитирует `messenger.message.sent` / `messenger.message.delivery_failed`.

### 3.5 RateLimiter (Messenger)

Алгоритм Token Bucket, ключ `{platform}:{chatId}`:

| Платформа  | rps | burstSize |
| ---------- | :-: | :-------: |
| `telegram` | 30  |    30     |
| `max`      | 20  |    20     |
| `web`      | 100 |    100    |
| `api`      | 100 |    100    |

---

## 4. MCP (Model Context Protocol)

### 4.1 ToolDefinition

Поля: `name`, `description`, `inputSchema: JsonSchema`, `requiredTier: AccessTier`, `category` (`file|shell|web|code|system|custom`), `timeout` (мс).

### 4.2 ToolRegistry

| Метод                               | Описание                                  |
| ----------------------------------- | ----------------------------------------- |
| `register(server: McpServerConfig)` | Регистрация всех инструментов MCP-сервера |
| `unregister(serverId)`              | Удаление сервера и его инструментов       |
| `findTool(name)`                    | Поиск по имени                            |
| `listTools(filter?)`                | Фильтрация по `category`/`tier`           |
| `getServer(toolName)`               | Конфигурация сервера инструмента          |

### 4.3 ToolAccessGuard

`checkAccess(tenantTier, tool)` -- проверка через `isTierAtLeast()`. Логирование отказов.

### 4.4 ToolExecutor

Выполнение с тайм-аутом (`Promise.race`). События: `mcp.tool.invoked`, `mcp.tool.completed`, `mcp.tool.failed`, `mcp.tool.timedout`.

### 4.5 ConversationOrchestrator

Цикл: `user message -> LLM -> tool_use? -> execute -> loop (max 10) -> response`.

1. Сообщение в историю -> LLM через `ILlmPort`
2. Парсинг `tool_use` блоков -> выполнение -> результаты в историю -> повтор
3. Финальный текстовый ответ

### 4.6 ConversationContext

`createContext(params)` -- maxHistoryTokens=100000. `trimHistory(ctx, estimateTokens)` -- обрезка старых сообщений (FIFO) для бюджета токенов.

---

## 5. Потоковая обработка (Streaming)

### 5.1 StreamParser

Автоопределение формата: SSE (`data: {...}\n\n`), JSON Lines (`{...}\n`), Raw Text (fallback). На первом чанке детектируется формат.

### 5.2 TokenAccumulator

Буферизация (~4 символа = 1 токен). Сброс по: `token_count` (порог), `timeout` (нет данных), `boundary`, `done` (принудительный).

### 5.3 LongMessageSplitter

Приоритет разрыва: абзац (`\n\n`, >50%) > предложение (`. `, >33%) > слово (` `, >25%) > жесткий разрез.

### 5.4 StreamConfig и платформенные настройки

Defaults: `flushTokenThreshold=50`, `flushTimeoutMs=500`, `maxMessageLength=4096`, `typingIndicatorIntervalMs=4000`.

| Платформа  | maxMessageLength | flushTokenThreshold | flushTimeoutMs | typing |
| ---------- | :--------------: | :-----------------: | :------------: | :----: |
| `telegram` |       4096       |         50          |      500       | 4000ms |
| `max`      |       4096       |         50          |      500       | 4000ms |
| `web`      | MAX_SAFE_INTEGER |         20          |      200       |  off   |
| `api`      | MAX_SAFE_INTEGER |         50          |      500       |  off   |

**BatchFallbackAdapter** -- заглушка без стриминга, накапливает текст, отдает через `getAccumulatedText()`.

---

## 6. Управление конкурентностью

### 6.1 WorkerPool и конфигурация

| Параметр               | Значение | Параметр                | Значение |
| ---------------------- | :------: | ----------------------- | :------: |
| `maxWorkers`           |    4     | `memoryLimitMb`         |   512    |
| `minWorkers`           |    1     | `backpressureThreshold` |   0.7    |
| `maxQueueSize`         |    32    | `heartbeatIntervalMs`   |   5000   |
| `workerTimeoutMs`      |  120000  | `stuckThresholdMs`      |  60000   |
| `maxRequestsPerWorker` |   100    |                         |          |

Состояния воркера: `idle -> busy -> draining -> stuck -> dead`.

### 6.2 PriorityScheduler

4 уровня: `critical > high > normal > low`. Внутри приоритета -- round-robin по тенантам. `enqueue(entry)`, `dequeue()`.

### 6.3 SessionMutex

Per-session блокировки: `acquire(sessionId, timeoutMs)`, `release(handle)`, `isLocked(sessionId)`. Автоосвобождение просроченных блокировок.

### 6.4 Backpressure

Формула: `level = queuePressure * 0.7 + workerUtilization * 0.3`.

| Уровень | Действие                         |
| :-----: | -------------------------------- |
|  < 0.5  | Минимум воркеров                 |
| 0.5-0.8 | Пропорциональное масштабирование |
| >= 0.8  | Максимум воркеров                |
| >= 0.7  | Отклонение новых запросов        |

### 6.5 ConcurrencyMetrics

Поля: `activeWorkers`, `idleWorkers`, `queueDepth`, `totalProcessed`, `totalErrors`, `avgLatencyMs`, `p95LatencyMs`, `p99LatencyMs`, `throughputPerMinute`, `backpressureLevel`, `stuckWorkers`.

---

## 7. Система плагинов

### 7.1 PluginManifest

Поля: `id`, `name`, `version`, `description`, `author`, `requiredTier`, `permissions: PluginPermission[]`, `configSchema?: JsonSchema`, `entryPoint`.

### 7.2 Конечный автомат

| Из           | Допустимые переходы  |
| ------------ | -------------------- |
| `registered` | `installed`, `error` |
| `installed`  | `active`, `error`    |
| `active`     | `disabled`, `error`  |
| `disabled`   | `active`, `error`    |
| `error`      | `disabled`           |

Функции: `transitionPlugin()`, `canTransition()`, `getValidTransitions()`.

### 7.3 Разрешения (6 типов)

`read_messages`, `send_messages`, `read_files`, `write_files`, `execute_tools`, `access_network`. Проверка: `PermissionGuard`.

### 7.4 Хуки (HookDispatcher, 7 типов)

| Хук                 | Момент                 |
| ------------------- | ---------------------- |
| `onMessageReceived` | Получение сообщения    |
| `onBeforeSend`      | Перед отправкой        |
| `onAfterSend`       | После отправки         |
| `onToolInvoked`     | Вызов инструмента      |
| `onToolCompleted`   | Завершение инструмента |
| `onSessionStart`    | Старт сессии           |
| `onSessionEnd`      | Завершение сессии      |

Результат: `HookResult { modified, data?, cancel? }` -- модификация данных или отмена операции.

### 7.5 PluginSandbox

Интерфейс `IPluginSandbox` для изолированного выполнения. `NoOpSandbox` -- заглушка.

---

## 8. Обучение и контекст (Training)

### 8.1 TrainingExample

Поля: `id`, `tenantId`, `input`, `expectedOutput`, `category` (`greeting|faq|task|error_handling|custom`), `quality` (1-5), `createdAt`, `metadata?`.

### 8.2 FeedbackProcessor

| Рейтинг    | Действие                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `positive` | Авто-создание TrainingExample (quality=4, category=`custom`) из input/output |
| `negative` | Флаг для проверки, событие `training.feedback.flagged_for_review`            |
| `neutral`  | Только сохранение                                                            |

### 8.3 ContextBuilder

Алгоритм: валидация system prompt (maxSystemPromptTokens=2000) -> выборка примеров (minQuality>=3) -> фильтрация по категориям -> сортировка по quality desc -> top-N (maxExamples=10) -> оценка токенов (~4 chars = 1 token).

### 8.4 ExampleValidator

Проверки: `input` не пуст, `expectedOutput` не пуст, `tenantId` обязателен, `category` валидна, `quality` 1-5.

---

## 9. AI Fabric -- абстракция провайдеров моделей

### 9.1 ModelProvider / ModelDefinition

**ModelProvider**: `id`, `name`, `baseUrl`, `models[]`, `rateLimit` (requestsPerMinute, tokensPerMinute, concurrentRequests), `priority`.

**ModelDefinition**: `id`, `name`, `provider`, `contextWindow`, `maxOutputTokens`, `costPer1kInput`, `costPer1kOutput`, `capabilities[]` (`chat|code|vision|tool_use|streaming|function_calling`).

### 9.2 ProviderRegistry

`register(provider)`, `unregister(id)`, `findModel(modelId)` -> `{provider, model}`, `listModels(filter?)`, `getAllProviders()`.

### 9.3 FallbackRouter

1. Попытка `primaryModel`, затем `fallbacks[]` по порядку
2. Каждая модель: `maxRetries` раз с exponential backoff (`delay * 2^(retry-1)`)
3. Non-recoverable ошибки прерывают повторы
4. Событие `ai-fabric.fallback.triggered` при переключении
5. Исчерпание цепочки -> `AllModelsFailedError`

### 9.4 TokenBudget (24-часовой сброс)

| Tier       | Лимит токенов |
| ---------- | :-----------: |
| `free`     |    10 000     |
| `standard` |    100 000    |
| `premium`  |   1 000 000   |
| `admin`    |   Infinity    |

Методы: `checkBudget()`, `recordUsage()`, `getUsage()`.

### 9.5 ModelSelector

Скоринг: capabilities match -> cost penalty (score -= cost*100) -> context window penalty (score -= 1000) -> capabilities bonus (score += count*10). Выбирает модель с наибольшим score.

### 9.6 AI RateLimiter

Per-provider, окно 1 мин: `requestsPerMinute`, `tokensPerMinute`, `concurrentRequests`. Автоочистка, расчет `retryAfterMs`.

---

## 10. Доменные события

### Session

`SessionCreated`, `SessionActivated`, `SessionExpired`, `SessionSuspended`, `TenantCreated`, `TenantTierChanged` (oldTier->newTier), `WorkspaceProvisioned`, `WorkspaceCleaned`, `ToolPolicyApplied`.

### Messenger

`messenger.message.received`, `messenger.message.sent`, `messenger.message.delivery_failed`, `messenger.webhook.received`, `messenger.webhook.validation_failed`.

### MCP

`mcp.tool.invoked`, `mcp.tool.completed`, `mcp.tool.failed`, `mcp.tool.timedout`, `mcp.conversation.started`, `mcp.conversation.completed`.

### Concurrency

`worker.spawned`, `worker.recycled` (reason: request_limit/memory_limit/manual), `worker.stuck`, `request.queued`, `request.started`, `request.completed`, `request.timedout`, `backpressure.activated`.

### Training

`training.example.added`, `training.example.removed`, `training.example.rated`, `training.feedback.received`, `training.feedback.flagged_for_review`, `training.context.built`, `training.context.invalidated`.

### Plugins

`plugin.registered`, `plugin.installed`, `plugin.activated`, `plugin.disabled`, `plugin.error`, `hook.executed`.

### AI Fabric

`ai-fabric.model.requested`, `ai-fabric.model.responded`, `ai-fabric.model.failed`, `ai-fabric.fallback.triggered`, `ai-fabric.rate_limit.hit`, `ai-fabric.token_budget.warning`.

---

## 11. Система типов

### 11.1 Result<T, E>

Дискриминированное объединение: `{ ok: true, value: T } | { ok: false, error: E }`. Конструкторы: `ok(value)`, `err(error)`. Guards: `isOk()`, `isErr()`. Разворачивание: `unwrap()` (бросает при ошибке).

### 11.2 Branded Types

| Тип               | Brand           | Формат                         |
| ----------------- | --------------- | ------------------------------ |
| `TenantIdString`  | `TenantId`      | `{platform}:{userId}:{chatId}` |
| `SessionIdString` | `SessionId`     | `session:{tenantId}`           |
| `WorkspacePath`   | `WorkspacePath` | `/workspaces/{tenantId}/...`   |

### 11.3 Иерархия ошибок

```
OpenClawError (abstract: code, recoverable, toUserMessage(), cause?)
├── ValidationError           (VALIDATION_ERROR, recoverable)
├── SecurityError             (SECURITY_ERROR, non-recoverable)
├── SessionError              (SESSION_ERROR, recoverable)
│   ├── SessionNotFound, TenantNotFound, TenantSuspended
│   ├── SessionExpired, InvalidStateTransition
├── ConcurrencyError          (CONCURRENCY_ERROR, recoverable)
│   ├── QueueFullError, WorkerTimeoutError, WorkerOOMError
│   ├── BackpressureError, LockAcquisitionError
├── StreamError               (STREAM_ERROR, recoverable)
├── ProviderError             (PROVIDER_ERROR, recoverable)
├── PluginError               (PLUGIN_ERROR, non-recoverable)
├── TrainingError             (TRAINING_ERROR, recoverable)
├── MessengerError            (MESSENGER_ERROR, recoverable)
│   ├── WebhookValidationError, MessageDeliveryError
│   ├── RateLimitError, PlatformUnavailableError
├── McpError                  (MCP_ERROR, recoverable)
│   ├── ToolNotFoundError, ToolAccessDeniedError (non-recoverable)
│   ├── ToolTimeoutError, ToolExecutionError, McpConnectionError
├── PluginSystemError         (PLUGIN_ERROR, recoverable)
│   ├── PluginNotFoundError, PluginInstallError
│   ├── PluginPermissionError, PluginExecutionError, PluginConfigError
├── AiFabricError             (AI_FABRIC_ERROR, recoverable)
│   ├── ModelNotFoundError, ModelOverloadedError
│   ├── AllModelsFailedError (non-recoverable)
│   ├── RateLimitExceededError, TokenBudgetExceededError
└── TrainingContextError      (TRAINING_ERROR, recoverable)
    ├── ExampleNotFoundError, InvalidExampleError
    ├── ContextTooLargeError, FeedbackError
```

### 11.4 ContentBlock

`TextBlock { type:'text', text }`, `ToolUseBlock { type:'tool_use', toolName, arguments, toolUseId }`, `ToolResultBlock { type:'tool_result', toolUseId, content, isError }`.

### 11.5 DomainEvent / EventBus

`DomainEvent<T>`: `type`, `payload: T`, `timestamp`, `correlationId` (UUID), `sourceContext`. Шина: `InProcessEventBus` -- `publish()`, `subscribe(type, handler)`, `subscribeAll(handler)`.

### 11.6 Dependency Injection

```typescript
const container = createContainer({ fileSystem, httpClient, subprocessFactory });
const eventBus = container.resolve(TOKENS.EVENT_BUS);
```

Контейнер замораживается после конфигурации. Все сервисы -- синглтоны. Токены: `EVENT_BUS`, `TENANT_STORE`, `SESSION_STORE`, `WORKSPACE_MANAGER`, `WORKER_POOL`, `PRIORITY_SCHEDULER`, `SESSION_MUTEX`, `WEBHOOK_ROUTER`, `MESSAGE_DISPATCHER`, `TOOL_REGISTRY`, `TOOL_ACCESS_GUARD`, `TOOL_EXECUTOR`, `EXAMPLE_STORE`, `FEEDBACK_STORE`, `CONTEXT_BUILDER`, `FEEDBACK_PROCESSOR`, `PLUGIN_REGISTRY`, `PLUGIN_LIFECYCLE`, `PERMISSION_GUARD`, `HOOK_DISPATCHER`, `PROVIDER_REGISTRY`, `AI_RATE_LIMITER`, `TOKEN_BUDGET`, `MODEL_SELECTOR`.
