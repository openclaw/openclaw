# Архитектура OpenClaw Platform

> `@openclaw/platform` v0.1.0 -- мультитенантная AI-агентская платформа

## 1. Обзор системы

OpenClaw -- серверная платформа для управления AI-агентами в мультитенантной среде.
Платформа принимает сообщения от мессенджеров (Telegram, Web), оркестрирует вызовы
LLM-моделей через Model Context Protocol (MCP), обеспечивает изоляцию тенантов
и управляет жизненным циклом плагинов.

- TypeScript ES2022, strict mode, Node.js >=22
- 9 ограниченных контекстов (bounded contexts) по DDD
- Result\<T, E\> вместо исключений для явной обработки ошибок
- Event Sourcing через InProcessEventBus
- Branded Types для семантической типобезопасности
- Dependency Injection через типизированный контейнер с токенами
- 793 unit-теста, 33 тестовых файла

## 2. Архитектурные принципы

### 2.1 Domain-Driven Design

Каждый bounded context содержит слои:

```
domain/       -- Сущности, value objects, доменные события, ошибки
application/  -- Use cases, сервисы, фабрики
ports/        -- Интерфейсы для внешних зависимостей
adapters/     -- Реализации портов
index.ts      -- Публичный API контекста
```

Зависимости направлены строго внутрь: adapters -> ports -> application -> domain.

### 2.2 Result\<T, E\> -- явная обработка ошибок

```typescript
type Result<T, E extends OpenClawError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

Все публичные методы возвращают `Result`. Утилиты: `ok()`, `err()`, `isOk()`, `isErr()`, `unwrap()`.

### 2.3 Branded Types

```typescript
type TenantIdString  = Branded<string, 'TenantId'>;    // "telegram:123:456"
type SessionIdString = Branded<string, 'SessionId'>;    // "sess_abc123"
type WorkspacePath   = Branded<string, 'WorkspacePath'>; // "/workspaces/..."
```

Компилятор запрещает подстановку обычного `string`, устраняя ошибки на этапе компиляции.

### 2.4 Event Sourcing

```typescript
interface DomainEvent<T = unknown> {
  readonly type: string;           readonly payload: T;
  readonly timestamp: Date;        readonly correlationId: string;
  readonly sourceContext: string;
}
```

## 3. Структура директорий

```
src/
  index.ts                  -- Реэкспорт всех контекстов
  core/
    types/                  -- Result, Branded, DomainEvent, errors, AccessTier,
                               TenantId, SessionId, MessengerPlatform, messages, timer
    di/                     -- InjectionToken<T>, DependencyContainer, ошибки DI
    infra/                  -- InProcessEventBus, Pino-логгер
    container.ts            -- TOKENS (33), createContainer()
  session/
    domain/                 -- tenant.ts, tenant-session.ts, tool-policy.ts, workspace-path.ts
    application/            -- workspace-manager.ts, path-validator.ts, in-memory stores
  concurrency/
    domain/                 -- types, config, metrics, errors, events
    application/            -- worker-pool, scheduler, backpressure, session-mutex,
                               worker-lifecycle, worker-health, subprocess-factory
  streaming/
    pipeline/               -- stream-parser, token-accumulator, long-message-splitter,
                               session-lock, streaming-response-handler
    adapters/               -- batch-fallback-adapter, messenger-stream-adapter
  messenger/
    ports/                  -- IMessengerPort
    adapters/               -- telegram-adapter, web-adapter, http-client
    application/            -- webhook-router, message-dispatcher, rate-limiter
  mcp/
    ports/                  -- ILlmPort, IMcpServerPort
    application/            -- tool-registry, tool-access-guard, tool-executor,
                               conversation-orchestrator, conversation-context
  training/
    application/            -- context-builder, feedback-processor, example-validator,
                               in-memory-example-store, in-memory-feedback-store
  plugins/
    domain/                 -- types, state-machine, errors, events
    application/            -- plugin-registry, plugin-lifecycle, permission-guard,
                               hook-dispatcher, plugin-sandbox
  ai-fabric/
    application/            -- fallback-router, provider-registry, model-selector,
                               rate-limiter, token-budget
```

## 4. Bounded Contexts

### 4.1 Core (core/) -- Shared Kernel

Общее ядро без бизнес-логики: базовые типы, DI-контейнер, шина событий, логгер.

| Компонент | Описание |
|-----------|----------|
| `Result<T,E>` | Дискриминированное объединение для обработки ошибок |
| `Branded<T,B>` | Номинальная типизация через phantom brand |
| `OpenClawError` | Базовый класс: code, recoverable, toUserMessage() |
| `DomainEventBus` | Интерфейс pub/sub с correlationId |
| `DependencyContainer` | Контейнер: register, resolve, createChildScope, freeze |

### 4.2 Session (session/) -- Тенанты и сессии

- `UserTenant` -- тенант с AccessTier, статусом suspended
- `TenantSession` -- сессия с машиной состояний
- `ToolAccessPolicy` -- политики доступа по уровню тенанта
- `WorkspacePath` -- branded-тип валидированного пути

**Автомат состояний сессии:**

```
  idle --> active --> processing
   |        |   <------'  |
   |        '-> expired   |
   '-------> suspended <--'
```

**События:** SessionCreated, SessionActivated, SessionExpired, SessionSuspended,
TenantCreated, TenantTierChanged, WorkspaceProvisioned, WorkspaceCleaned, ToolPolicyApplied

### 4.3 Concurrency (concurrency/) -- Пул воркеров

- `WorkerPool` -- оркестратор: submit(), getMetrics(), shutdown()
- `PriorityScheduler` -- 4 уровня приоритета, round-robin по тенантам
- `SessionMutex` -- сериализация запросов внутри сессии
- `WorkerLifecycle` / `WorkerHealth` -- spawn, kill, recycle, heartbeat
- `Backpressure` -- защита от перегрузки (формула в разделе 8)

Конфигурация: maxWorkers=4, minWorkers=1, maxQueueSize=32, workerTimeoutMs=120s,
maxRequestsPerWorker=100, memoryLimitMb=512, backpressureThreshold=0.7

**События:** WorkerSpawned, WorkerRecycled, WorkerStuck, RequestQueued,
RequestStarted, RequestCompleted, RequestTimedOut, BackpressureActivated

### 4.4 Streaming (streaming/) -- Потоковая обработка

- `StreamParser` -- автодетект формата (SSE, JSON Lines, raw text)
- `TokenAccumulator` -- буферизация токенов до порога flush
- `LongMessageSplitter` -- разбиение по лимитам платформы
- `SessionLock` -- предотвращение конкурентной отправки
- `BatchFallbackAdapter` -- fallback для платформ без стриминга

### 4.5 Messenger (messenger/) -- Мессенджеры

**Порт:** `IMessengerPort` -- sendMessage, editMessage, deleteMessage,
sendTypingIndicator, parseWebhook, validateWebhookSignature

**Адаптеры:** `TelegramAdapter` (HMAC-SHA256), `WebAdapter` (HTTP REST)

**Application:** `WebhookRouter` (маршрутизация + валидация подписи),
`MessageDispatcher`, `RateLimiter`

**События:** MessageReceived, MessageSent, MessageDeliveryFailed,
WebhookReceived, WebhookValidationFailed

### 4.6 MCP (mcp/) -- Model Context Protocol

- `ToolRegistry` -- хранилище инструментов и серверов
- `ToolAccessGuard` -- проверка доступа по AccessTier
- `ToolExecutor` -- выполнение с публикацией событий
- `ConversationOrchestrator` -- цикл "LLM -> tool_use -> tool_result" (до 10 итераций)

**Порты:** `ILlmPort`, `IMcpServerPort`

**События:** ToolInvoked, ToolCompleted, ToolFailed, ToolTimedOut,
ConversationStarted, ConversationCompleted

### 4.7 Training (training/) -- Обучение

- `ExampleValidator`, `ContextBuilder`, `FeedbackProcessor`
- `InMemoryExampleStore` / `InMemoryFeedbackStore`

**События:** ExampleAdded, ExampleRemoved, ExampleRated, FeedbackReceived,
ContextBuilt, ContextInvalidated, FeedbackFlaggedForReview

### 4.8 Plugins (plugins/) -- Система плагинов

- `PluginManifest` -- id, version, requiredTier, permissions[], entryPoint
- `PluginPermission` -- read_messages, send_messages, read_files, write_files,
  execute_tools, access_network
- `HookName` -- 7 хуков: onMessageReceived, onBeforeSend, onAfterSend,
  onToolInvoked, onToolCompleted, onSessionStart, onSessionEnd
- `PluginLifecycle`, `PermissionGuard`, `HookDispatcher`, `IPluginSandbox`

**События:** PluginRegistered, PluginInstalled, PluginActivated,
PluginDisabled, PluginError, HookExecuted

### 4.9 AI Fabric (ai-fabric/) -- LLM-провайдеры

- `ModelProvider` -- baseUrl, models[], rateLimit, priority
- `ModelDefinition` -- contextWindow, cost, capabilities (chat/code/vision/tool_use/streaming)
- `FallbackRouter` -- retry с exponential backoff + fallback по цепочке
- `TokenBudget`, `RateLimiter`, `ModelSelector`, `ProviderRegistry`

**События:** ModelRequested, ModelResponded, ModelFailed, FallbackTriggered,
RateLimitHit, TokenBudgetWarning

## 5. Dependency Injection

### 5.1 DependencyContainer

```typescript
class DependencyContainer {
  register<T>(token: InjectionToken<T>, factory: () => T, opts?): void;
  resolve<T>(token: InjectionToken<T>): T;  // singleton по умолчанию
  has(token): boolean;
  createChildScope(): DependencyContainer;   // наследует родителя
  freeze(): void;                            // блокирует регистрации
}
```

Фабрика `createContainer({ fileSystem, httpClient, subprocessFactory })` регистрирует
все сервисы и замораживает контейнер.

### 5.2 TOKENS (33 штуки)

| Контекст | Токены |
|----------|--------|
| Core | EVENT_BUS |
| Session | TENANT_STORE, SESSION_STORE, WORKSPACE_MANAGER, FILE_SYSTEM |
| Concurrency | WORKER_POOL, PRIORITY_SCHEDULER, SESSION_MUTEX, SUBPROCESS_FACTORY, CONCURRENCY_CONFIG |
| Streaming | BATCH_ADAPTER |
| Messenger | WEBHOOK_ROUTER, MESSAGE_DISPATCHER, MESSENGER_RATE_LIMITER, WEB_ADAPTER, HTTP_CLIENT |
| MCP | TOOL_REGISTRY, TOOL_ACCESS_GUARD, TOOL_EXECUTOR |
| Training | EXAMPLE_STORE, FEEDBACK_STORE, CONTEXT_BUILDER, FEEDBACK_PROCESSOR, EXAMPLE_VALIDATOR |
| Plugins | PLUGIN_REGISTRY, PLUGIN_LIFECYCLE, PERMISSION_GUARD, HOOK_DISPATCHER, PLUGIN_SANDBOX |
| AI Fabric | PROVIDER_REGISTRY, AI_RATE_LIMITER, TOKEN_BUDGET, MODEL_SELECTOR |

Порты ILlmPort, IMcpServerPort, IModelPort регистрируются потребителем через child scope.

## 6. Event-Driven Architecture

### 6.1 InProcessEventBus

Обработчики выполняются параллельно через `Promise.all`. Ошибки изолированы --
падение одного обработчика не влияет на остальных (логирование через Pino).

### 6.2 Реестр доменных событий (42 типа)

| Контекст | События |
|----------|---------|
| Session | SessionCreated, SessionActivated, SessionExpired, SessionSuspended, TenantCreated, TenantTierChanged, WorkspaceProvisioned, WorkspaceCleaned, ToolPolicyApplied |
| Concurrency | WorkerSpawned, WorkerRecycled, WorkerStuck, RequestQueued, RequestStarted, RequestCompleted, RequestTimedOut, BackpressureActivated |
| Messenger | MessageReceived, MessageSent, MessageDeliveryFailed, WebhookReceived, WebhookValidationFailed |
| MCP | ToolInvoked, ToolCompleted, ToolFailed, ToolTimedOut, ConversationStarted, ConversationCompleted |
| Training | ExampleAdded, ExampleRemoved, ExampleRated, FeedbackReceived, ContextBuilt, ContextInvalidated, FeedbackFlaggedForReview |
| Plugins | PluginRegistered, PluginInstalled, PluginActivated, PluginDisabled, PluginError, HookExecuted |
| AI Fabric | ModelRequested, ModelResponded, ModelFailed, FallbackTriggered, RateLimitHit, TokenBudgetWarning |

## 7. Архитектура безопасности

### 7.1 Уровни доступа: `free < standard < premium < admin`

| Уровень | Инструменты | Concurrent | Approval |
|---------|-------------|-----------|----------|
| free | Read, Glob, Grep, WebFetch | 1 | Да |
| standard | + Write, Edit, NotebookEdit | 2 | Нет |
| premium | + Bash, WebSearch, Skill, TodoWrite | 4 | Нет |
| admin | Все | Без лимита | Нет |

Маппинг SandboxTier: free->restricted, standard->standard, premium/admin->full.

### 7.2 Изоляция рабочих пространств

- Тенант получает `/workspaces/{tenantId}`, путь валидируется branded-типом
- Запрет directory traversal (`..`), путь должен быть абсолютным
- `WorkspaceManager.validatePath()` проверяет принадлежность пути тенанту

### 7.3 Верификация webhook-подписей

```typescript
// TelegramAdapter -- HMAC-SHA256 + timingSafeEqual (защита от timing attacks)
const hmac = crypto.createHmac('sha256', secret);
hmac.update(payload.rawBody);
crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hmac.digest('hex')));
```

### 7.4 Прочие механизмы

- `ToolAccessGuard` -- контроль доступа к инструментам по AccessTier
- `PermissionGuard` -- разрешения плагинов (6 типов)
- `TokenBudget` -- лимит токенов на тенанта
- `RateLimiter` -- ограничение частоты по платформе и провайдеру

## 8. Модель конкурентности

### 8.1 Backpressure

```
level = queuePressure * 0.7 + workerUtilization * 0.3
queuePressure     = min(queueDepth / maxQueueSize, 1.0)
workerUtilization = activeWorkers / totalWorkers
level >= 0.7 (threshold) => новые запросы отклоняются
```

Адаптивное масштабирование: >=0.8 -> maxWorkers, >=0.5 -> пропорционально, <0.5 -> minWorkers

### 8.2 Session Mutex

Мьютекс гарантирует последовательную обработку в рамках одной сессии. Lock имеет TTL.

## 9. Диаграммы

### 9.1 Общая архитектура

```
+------------------------------------------------------------------+
|                        OpenClaw Platform                          |
|                                                                    |
|  +----------+  +----------+  +---------+  +---------+  +--------+ |
|  | Telegram |  |   Web    |  | Webhook |  | Message |  |  Rate  | |
|  | Adapter  |  | Adapter  |  | Router  |  | Dispatch|  | Limiter| |
|  +-----+----+  +----+-----+  +----+----+  +----+----+  +--------+ |
|        '-------------+------+------'             |                  |
|  +---------------------------v-------------------v---------------+ |
|  |                     DomainEventBus                            | |
|  +------+--------+--------+--------+--------+--------+----------+ |
|  +------v-+ +----v---+ +-v------+ +v------+ +v------+ +--------+ |
|  |Session | |Concur- | |Stream- | | MCP   | |Train- | |Plugins | |
|  |Context | |rency   | |ing     | |Context| |ing    | |Context | |
|  +--------+ +--------+ +--------+ +---+---+ +-------+ +--------+ |
|                                        |                          |
|                                   +----v----+                     |
|                                   |AI Fabric|                     |
|                                   +----+----+                     |
+----------------------------------------|-------------------------+
                                         v
                              LLM Providers (external)
```

### 9.2 Поток обработки запроса

```
Telegram/Web --webhook--> WebhookRouter --validate+parse--> emit: MessageReceived
                                                                    |
         +----------------------------------------------------------v
         |                   ConversationOrchestrator
         |                          |
         |               +-------> LLM Port ---+---> TextBlock ----> response
         |               |                     |
         |               |              ToolUseBlock
         |               |                     |
         |               |            ToolAccessGuard -> ToolExecutor
         |               |                     |
         |               +--- ToolResultBlock -+
         |                          |
         +------ emit: ConversationCompleted
                                    |
                     StreamingResponseHandler -> TokenAccumulator
                                    |
                          LongMessageSplitter -> MessageDispatcher
                                    |
                       TelegramAdapter.sendMessage()
```

### 9.3 Жизненный цикл воркера

```
  spawn() --> [idle] <--> [busy] --> [draining] --> [dead]
                |                        ^
                v                   maxRequests/OOM
             [stuck] --> kill()
```

Состояния WorkerState: `idle | busy | draining | stuck | dead`

### 9.4 Автомат состояний плагина

```
 [registered] --> [installed] --> [active] <--> [disabled]
      |               |              |              |
      '-------> [error] <-----------'              |
                   |                                |
                   '----------> [disabled] <--------'
```

Переходы: registered->{installed, error}, installed->{active, error},
active->{disabled, error}, disabled->{active, error}, error->{disabled}.

## 10. Технологический стек

| Категория | Технология | Версия |
|-----------|-----------|--------|
| Язык | TypeScript (ES2022, strict) | ^5.5.0 |
| Рантайм | Node.js | >=22.12.0 |
| Логирование | Pino | ^9.0.0 |
| Тестирование | Vitest | ^2.0.0 |
| Покрытие | @vitest/coverage-v8 | ^2.0.0 |
| Линтер | ESLint + typescript-eslint | ^9.39.2 / ^8.55.0 |
| Модульная система | ESM (type: "module"), Node16 resolution |

**Строгие настройки TypeScript:** noUncheckedIndexedAccess, noUnusedLocals, noUnusedParameters,
declaration + declarationMap + sourceMap.

```bash
pnpm run build        # tsc -b
pnpm test             # vitest run (793 теста, 33 файла)
pnpm run lint         # eslint src/ tests/
pnpm run typecheck    # tsc --noEmit
pnpm run check        # typecheck + test
```
