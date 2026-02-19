# OpenClaw Platform -- Руководство разработчика

## 1. Быстрый старт

Платформа построена на DDD. Точка входа -- DI-контейнер со всеми сервисами.

```typescript
import {
  createContainer,
  TOKENS,
  createUserTenant,
  createTenantId,
  createSessionId,
  createTenantSession,
  TelegramAdapter,
  type TenantIdString,
} from "@openclaw/platform";

const container = createContainer({ fileSystem, httpClient, subprocessFactory });

const tenantId = createTenantId({ platform: "telegram", userId: "123", chatId: "456" });
const tenant = createUserTenant({ tenantId, platform: "telegram" });
const sessionId = createSessionId(tenantId);
const session = createTenantSession(sessionId, tenantId);

const dispatcher = container.resolve(TOKENS.MESSAGE_DISPATCHER);
const telegram = new TelegramAdapter(httpClient, "BOT_TOKEN");
dispatcher.register("telegram", telegram);

const result = await dispatcher.dispatch(tenantId, { chatId: "456", text: "Привет!" });
if (result.ok) console.log("Отправлено:", result.value.messageId);
```

## 2. Работа с тенантами

`UserTenant` -- корневой агрегат. Все функции иммутабельны.

```typescript
import {
  createUserTenant,
  touchTenant,
  changeTenantTier,
  suspendTenant,
  reinstateTenant,
  parseTenantId,
  type TenantIdString,
} from "@openclaw/platform";

const tenant = createUserTenant({
  tenantId: "telegram:user123:chat456" as TenantIdString,
  platform: "telegram",
  tier: "free", // 'free' | 'standard' | 'premium' | 'admin'
  workspacePath: "/workspaces/telegram-user123-chat456",
});

const active = touchTenant(tenant); // обновляет lastActiveAt
const upgraded = changeTenantTier(active, "premium");
const frozen = suspendTenant(upgraded); // suspended = true
const restored = reinstateTenant(frozen); // suspended = false

const { platform, userId, chatId } = parseTenantId(tenant.tenantId);
```

## 3. Управление сессиями

Конечный автомат: `idle` -> `active` -> `processing` -> `active` -> `expired`. Любое -> `suspended`.

```typescript
import {
  createTenantSession,
  createSessionId,
  transitionSession,
  isSessionExpired,
  extendSession,
  isValidTransition,
} from "@openclaw/platform";

const session = createTenantSession(createSessionId(tenantId), tenantId, 30 * 60 * 1000);

const r1 = transitionSession(session, "active"); // idle -> active
if (r1.ok) {
  const r2 = transitionSession(r1.value, "processing"); // active -> processing
  if (r2.ok) transitionSession(r2.value, "active"); // processing -> active
}

if (isSessionExpired(session)) console.log("Истекла");
const extended = extendSession(session, 15 * 60 * 1000);

isValidTransition("idle", "active"); // true
isValidTransition("expired", "active"); // false
```

## 4. Отправка и получение сообщений

### Telegram

```typescript
import { TelegramAdapter, type WebhookPayload, TOKENS } from "@openclaw/platform";

const telegram = new TelegramAdapter(httpClient, BOT_TOKEN);

const webhookRouter = container.resolve(TOKENS.WEBHOOK_ROUTER);
webhookRouter.register("telegram", telegram, WEBHOOK_SECRET);

const dispatcher = container.resolve(TOKENS.MESSAGE_DISPATCHER);
dispatcher.register("telegram", telegram);

// Отправка
await dispatcher.dispatch(tenantId, {
  chatId: "456",
  text: "Привет!",
  parseMode: "markdown",
});

// Приём вебхука
const payload: WebhookPayload = {
  platform: "telegram",
  rawBody: raw,
  headers,
  receivedAt: new Date(),
};
const msg = await webhookRouter.route(payload);
if (msg.ok) console.log(`${msg.value.userId}: ${msg.value.text}`);
```

### Web

```typescript
import { WebAdapter } from "@openclaw/platform";

const web = new WebAdapter();
webhookRouter.register("web", web, "my-api-key");
dispatcher.register("web", web);
await dispatcher.dispatch(webTenantId, { chatId: "room-1", text: "Ответ" });

const pending = web.getMessages("room-1"); // polling
web.clearMessages("room-1");
```

## 5. Инструменты (MCP Tools)

### Регистрация и поиск

```typescript
import { type McpServerConfig, TOKENS } from "@openclaw/platform";

const registry = container.resolve(TOKENS.TOOL_REGISTRY);
registry.register({
  serverId: "fs-tools",
  name: "FS Tools",
  command: "npx",
  args: ["-y", "@mcp/fs"],
  env: {},
  tools: [
    {
      name: "readFile",
      description: "Чтение файла",
      requiredTier: "free",
      category: "file",
      timeout: 10000,
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
});

const tool = registry.findTool("readFile");
const fileTools = registry.listTools({ category: "file" });
```

### Проверка доступа и выполнение

```typescript
const guard = container.resolve(TOKENS.TOOL_ACCESS_GUARD);
const access = guard.checkAccess("free", tool!); // Result<void, ToolAccessDeniedError>

const executor = container.resolve(TOKENS.TOOL_EXECUTOR);
const result = await executor.execute(invocation, registry.getServer("readFile")!, 30000);
```

### Контекст разговора

```typescript
import { createContext, trimHistory } from "@openclaw/platform";

const ctx = createContext({
  sessionId: sid,
  tenantId,
  tier: "premium",
  history: messages,
  maxHistoryTokens: 50000,
});
const trimmed = trimHistory(ctx, (text) => Math.ceil(text.length / 4));
```

## 6. Потоковая обработка

```typescript
import {
  StreamParser,
  TokenAccumulator,
  LongMessageSplitter,
  DEFAULT_STREAM_CONFIG,
} from "@openclaw/platform";

// Парсинг (автоопределение: SSE / JSON Lines / raw text)
const parser = new StreamParser();
const events = parser.parse('data: {"type":"text_delta","data":"Привет"}\n\n');

// Накопление токенов (сброс по порогу или таймауту)
const acc = new TokenAccumulator(DEFAULT_STREAM_CONFIG, timer);
const flush = acc.accumulate("текст..."); // FlushResult | undefined
const final = acc.flush("done");

// Разбиение длинных сообщений (абзац > предложение > слово > жёсткое)
const splitter = new LongMessageSplitter();
const chunks = splitter.split(longText, 4096);
for (const chunk of chunks) {
  await dispatcher.dispatch(tenantId, { chatId, text: chunk });
}
```

## 7. Управление конкурентностью

### WorkerPool

```typescript
const pool = container.resolve(TOKENS.WORKER_POOL);

const result = await pool.submit({
  id: crypto.randomUUID(),
  tenantId,
  sessionId: sid,
  priority: "normal",
  timeoutMs: 30000,
  payload: { prompt: "Анекдот" },
});
if (result.ok) console.log(`${result.value.processingTimeMs} мс`);

const m = pool.getMetrics();
// m.activeWorkers, m.queueDepth, m.p95LatencyMs, m.backpressureLevel

await pool.shutdown();
```

### PriorityScheduler

```typescript
import { PriorityScheduler, type QueueEntry } from "@openclaw/platform";

const scheduler = new PriorityScheduler(1000);
scheduler.enqueue({
  id: "1",
  tenantId,
  priority: "high",
  enqueuedAt: new Date(),
  timeoutMs: 5000,
  payload: {},
});
const next = scheduler.dequeue(); // round-robin между тенантами
```

### SessionMutex

```typescript
const mutex = container.resolve(TOKENS.SESSION_MUTEX);
const lock = await mutex.acquire(sid, 10000);
if (lock.ok) {
  try {
    await processRequest();
  } finally {
    mutex.release(lock.value);
  }
}
```

## 8. Работа с плагинами

Жизненный цикл: `registered` -> `installed` -> `active` -> `disabled`.

```typescript
import { type PluginManifest, TOKENS } from "@openclaw/platform";

const registry = container.resolve(TOKENS.PLUGIN_REGISTRY);
const lifecycle = container.resolve(TOKENS.PLUGIN_LIFECYCLE);
const hooks = container.resolve(TOKENS.HOOK_DISPATCHER);

// Регистрация
registry.register({
  id: "weather",
  name: "Weather",
  version: "1.0.0",
  description: "Погода",
  author: "team",
  requiredTier: "standard",
  permissions: ["access_network", "send_messages"],
  entryPoint: "./plugins/weather.js",
});

// Установка -> Активация
lifecycle.install("weather", { apiKey: process.env.WEATHER_KEY });
lifecycle.activate("weather");

// Хуки (onMessageReceived, onBeforeSend, onAfterSend, onToolInvoked,
//        onToolCompleted, onSessionStart, onSessionEnd)
hooks.registerHook({ pluginId: "weather", hookName: "onMessageReceived", priority: 10 });

const hookResult = await hooks.dispatch(
  "onMessageReceived",
  { tenantId: tid, sessionId: sid, data: { text: "Погода?" } },
  async (pluginId, hookName, ctx) => ({ modified: true, data: { ...ctx.data, weather: "25C" } }),
);
if (hookResult.cancel) console.log("Плагин отменил обработку");

// Отключение
lifecycle.disable("weather");
```

## 9. AI Fabric -- работа с моделями

```typescript
import { type ModelProvider, TOKENS } from "@openclaw/platform";

const providerRegistry = container.resolve(TOKENS.PROVIDER_REGISTRY);
providerRegistry.register({
  id: "anthropic",
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  priority: 1,
  rateLimit: { requestsPerMinute: 60, tokensPerMinute: 100000, concurrentRequests: 5 },
  models: [
    {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
      contextWindow: 200000,
      maxOutputTokens: 8192,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      capabilities: ["chat", "code", "tool_use", "streaming", "function_calling"],
    },
  ],
});

// Выбор модели по capabilities и стоимости
const selector = container.resolve(TOKENS.MODEL_SELECTOR);
const models = providerRegistry.listModels({ capability: "tool_use" });
const best = selector.select(
  { tenantId, modelId: "claude-sonnet", messages: [{ role: "user", content: "Код" }] },
  models,
);

// Бюджет токенов (суточный, сбрасывается автоматически)
const budget = container.resolve(TOKENS.TOKEN_BUDGET);
budget.setTenantTier(tenantId, "premium"); // free=10K, standard=100K, premium=1M, admin=inf
budget.checkBudget(tenantId, 5000); // Result<void, TokenBudgetExceededError>
budget.recordUsage(tenantId, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
const { used, remaining } = budget.getUsage(tenantId);
```

## 10. Обучение и обратная связь

```typescript
import { TOKENS } from "@openclaw/platform";

const validator = container.resolve(TOKENS.EXAMPLE_VALIDATOR);
const store = container.resolve(TOKENS.EXAMPLE_STORE);
const builder = container.resolve(TOKENS.CONTEXT_BUILDER);
const feedback = container.resolve(TOKENS.FEEDBACK_PROCESSOR);

// Валидация и сохранение примера
const v = validator.validate({
  tenantId,
  input: "Как оформить возврат?",
  expectedOutput: 'Перейдите в "Мои заказы"...',
  category: "faq",
  quality: 4,
});
if (v.ok) await store.save(v.value);

// Построение контекста для AI
const ctx = await builder.build(tenantId, "Ты -- помощник магазина.", {
  maxExamples: 5,
  minQuality: 3,
  includeCategories: ["faq", "task"],
});
// ctx.value.systemPrompt, ctx.value.examples, ctx.value.maxTokens

// Обратная связь
await feedback.process({
  id: crypto.randomUUID(),
  tenantId,
  messageId: "msg-123",
  rating: "positive",
  comment: "Отличный ответ!",
  createdAt: new Date(),
});
```

Категории примеров: `greeting`, `faq`, `task`, `error_handling`, `custom`. Качество: 1-5.

## 11. Обработка ошибок

Все операции возвращают `Result<T, E>` вместо исключений.

```typescript
import { isOk, isErr, unwrap, type OpenClawError } from "@openclaw/platform";

const result = await pool.submit(request);
if (result.ok) {
  console.log(result.value);
} else {
  const e = result.error;
  console.error(`[${e.code}] ${e.message}`); // машинный формат
  console.error(e.toUserMessage()); // для пользователя
  console.log(`Восстанавливаемая: ${e.recoverable}`);
}
```

| Класс              | Код                 | Восстанавливаемая |
| ------------------ | ------------------- | ----------------- |
| `ValidationError`  | `VALIDATION_ERROR`  | да                |
| `SecurityError`    | `SECURITY_ERROR`    | нет               |
| `SessionError`     | `SESSION_ERROR`     | да                |
| `ConcurrencyError` | `CONCURRENCY_ERROR` | да                |
| `StreamError`      | `STREAM_ERROR`      | да                |
| `ProviderError`    | `PROVIDER_ERROR`    | да                |
| `PluginError`      | `PLUGIN_ERROR`      | нет               |
| `TrainingError`    | `TRAINING_ERROR`    | да                |

Специализированные: `QueueFullError`, `WorkerTimeoutError`, `BackpressureError`,
`ToolAccessDeniedError`, `ToolTimeoutError`, `MessageDeliveryError`, `RateLimitError`,
`TokenBudgetExceededError`, `LockAcquisitionError`, `PluginNotFoundError` и др.

## 12. Доменные события

```typescript
const eventBus = container.resolve(TOKENS.EVENT_BUS);

// Подписка на тип
const unsub = eventBus.subscribe("mcp.tool.completed", (event) => {
  console.log(event.payload, event.timestamp, event.correlationId);
});

// Подписка на все (аудит)
const unsubAll = eventBus.subscribeAll((event) => {
  console.log(`[${event.sourceContext}] ${event.type}`);
});

unsub();
unsubAll(); // отписка

// Создание события
import { createEvent } from "@openclaw/platform";
eventBus.publish(createEvent("custom.event", { data: 1 }, "my-context"));
```

Основные события: `messenger.message.received`, `messenger.message.sent`,
`mcp.tool.invoked`, `mcp.tool.completed`, `mcp.tool.failed`, `mcp.tool.timedout`,
`mcp.conversation.started`, `mcp.conversation.completed`,
`plugin.installed`, `plugin.activated`, `plugin.disabled`.

## 13. Dependency Injection

```typescript
import { createContainer, TOKENS, DependencyContainer, InjectionToken } from "@openclaw/platform";

// Стандартный контейнер (все сервисы зарегистрированы, заморожен)
const container = createContainer({ fileSystem, httpClient, subprocessFactory });
const eventBus = container.resolve(TOKENS.EVENT_BUS);

// Проверка
container.has(TOKENS.WORKER_POOL); // true

// Дочерняя область видимости
const child = container.createChildScope();

// Пользовательский контейнер
const custom = new DependencyContainer();
const TOKEN = new InjectionToken<string>("MyService");
custom.register(TOKEN, () => "value", { singleton: true });
custom.freeze();
```

Полный список TOKENS: `EVENT_BUS`, `TENANT_STORE`, `SESSION_STORE`, `WORKSPACE_MANAGER`,
`FILE_SYSTEM`, `WORKER_POOL`, `SESSION_MUTEX`, `WEBHOOK_ROUTER`, `MESSAGE_DISPATCHER`,
`MESSENGER_RATE_LIMITER`, `WEB_ADAPTER`, `HTTP_CLIENT`, `TOOL_REGISTRY`, `TOOL_ACCESS_GUARD`,
`TOOL_EXECUTOR`, `EXAMPLE_STORE`, `FEEDBACK_STORE`, `CONTEXT_BUILDER`, `FEEDBACK_PROCESSOR`,
`EXAMPLE_VALIDATOR`, `PLUGIN_REGISTRY`, `PLUGIN_LIFECYCLE`, `PERMISSION_GUARD`,
`HOOK_DISPATCHER`, `PLUGIN_SANDBOX`, `PROVIDER_REGISTRY`, `AI_RATE_LIMITER`,
`TOKEN_BUDGET`, `MODEL_SELECTOR`.

## 14. Политики доступа к инструментам

```typescript
import { getDefaultPolicy, isToolAllowed } from "@openclaw/platform";

const policy = getDefaultPolicy("standard");
isToolAllowed(policy, "Read"); // true
isToolAllowed(policy, "Bash"); // false (нужен premium)
```

| Тариф      | Инструменты                         | Параллельность  | Одобрение |
| ---------- | ----------------------------------- | --------------- | --------- |
| `free`     | Read, Glob, Grep, WebFetch          | 1               | да        |
| `standard` | + Write, Edit, NotebookEdit         | 2               | нет       |
| `premium`  | + Bash, WebSearch, Skill, TodoWrite | 4               | нет       |
| `admin`    | все                                 | нет ограничений | нет       |

## 15. Типичные сценарии использования

### Telegram-бот с AI (end-to-end)

```typescript
async function handleWebhook(raw: string, headers: Record<string, string>) {
  const payload: WebhookPayload = {
    platform: "telegram",
    rawBody: raw,
    headers,
    receivedAt: new Date(),
  };
  const msgResult = await webhookRouter.route(payload);
  if (!msgResult.ok) return;

  const msg = msgResult.value;
  const tenantId = createTenantId({
    platform: "telegram",
    userId: msg.userId,
    chatId: msg.chatId,
  });
  const tenant = createUserTenant({ tenantId, platform: "telegram", tier: "standard" });
  budget.setTenantTier(tenantId, tenant.tier);

  const budgetCheck = budget.checkBudget(tenantId, 2000);
  if (!budgetCheck.ok) {
    await dispatcher.dispatch(tenantId, { chatId: msg.chatId, text: "Лимит исчерпан." });
    return;
  }
  await dispatcher.dispatch(tenantId, {
    chatId: msg.chatId,
    text: `Вы сказали: ${msg.text}`,
    replyToMessageId: msg.messageId,
  });
}
```

### Мультиплатформенная настройка

```typescript
webhookRouter.register("telegram", new TelegramAdapter(httpClient, TG_TOKEN), TG_SECRET);
webhookRouter.register("web", new WebAdapter(), WEB_KEY);
dispatcher.register("telegram", telegram);
dispatcher.register("web", web);
// Платформа определяется автоматически из tenantId
```

### Добавление плагина

```typescript
registry.register({
  id: "analytics",
  name: "Analytics",
  version: "2.0.0",
  description: "Аналитика",
  author: "team",
  requiredTier: "free",
  permissions: ["read_messages"],
  entryPoint: "./plugins/analytics.js",
});
lifecycle.install("analytics", { endpoint: "https://analytics.local" });
lifecycle.activate("analytics");
hooks.registerHook({ pluginId: "analytics", hookName: "onAfterSend", priority: 100 });
```

### Персонализация через обучающий контекст

```typescript
const examples = [
  {
    input: "Привет!",
    expectedOutput: "Здравствуйте!",
    category: "greeting" as const,
    quality: 5 as const,
  },
  {
    input: "Статус #100",
    expectedOutput: "Заказ #100 доставлен.",
    category: "task" as const,
    quality: 4 as const,
  },
];
for (const ex of examples) {
  const r = validator.validate({ ...ex, tenantId });
  if (r.ok) await store.save(r.value);
}
const ctx = await builder.build(tenantId, "Ты -- помощник магазина Лапка.");
// ctx.value.systemPrompt + ctx.value.examples -> отправляем в AI модель
```
