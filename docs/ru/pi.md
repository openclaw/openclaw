---
title: "Архитектура интеграции Pi"
---

# Архитектура интеграции Pi

В этом документе описывается, как OpenClaw интегрируется с [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) и его родственными пакетами (`pi-ai`, `pi-agent-core`, `pi-tui`) для обеспечения возможностей AI-агента.

## Обзор

OpenClaw использует SDK pi для встраивания AI-агента для программирования в архитектуру своего messaging Gateway (шлюза). Вместо запуска pi как подпроцесса или использования режима RPC, OpenClaw напрямую импортирует и инстанцирует `AgentSession` pi через `createAgentSession()`. Такой встроенный подход обеспечивает:

- Полный контроль над жизненным циклом сеанса и обработкой событий
- Пользовательскую инъекцию инструментов (сообщения, sandbox, действия, специфичные для каналов)
- Кастомизацию системного промпта для каждого канала/контекста
- Персистентность сеансов с поддержкой ветвления и уплотнения
- Ротацию профилей аутентификации для нескольких аккаунтов с отказоустойчивостью
- Провайдер-агностичное переключение моделей

## Зависимости пакетов

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Пакет             | Назначение                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Базовые абстракции LLM: `Model`, `streamSimple`, типы сообщений, API провайдеров                                    |
| `pi-agent-core`   | Цикл агента, выполнение инструментов, типы `AgentMessage`                                                                           |
| `pi-coding-agent` | SDK высокого уровня: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, встроенные инструменты |
| `pi-tui`          | Компоненты терминального UI (используются в локальном TUI-режиме OpenClaw)                                       |

## Структура файлов

```
src/agents/
├── pi-embedded-runner.ts          # Re-exports from pi-embedded-runner/
├── pi-embedded-runner/
│   ├── run.ts                     # Main entry: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # Single attempt logic with session setup
│   │   ├── params.ts              # RunEmbeddedPiAgentParams type
│   │   ├── payloads.ts            # Build response payloads from run results
│   │   ├── images.ts              # Vision model image injection
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # Abort error detection
│   ├── cache-ttl.ts               # Cache TTL tracking for context pruning
│   ├── compact.ts                 # Manual/auto compaction logic
│   ├── extensions.ts              # Load pi extensions for embedded runs
│   ├── extra-params.ts            # Provider-specific stream params
│   ├── google.ts                  # Google/Gemini turn ordering fixes
│   ├── history.ts                 # History limiting (DM vs group)
│   ├── lanes.ts                   # Session/global command lanes
│   ├── logger.ts                  # Subsystem logger
│   ├── model.ts                   # Model resolution via ModelRegistry
│   ├── runs.ts                    # Active run tracking, abort, queue
│   ├── sandbox-info.ts            # Sandbox info for system prompt
│   ├── session-manager-cache.ts   # SessionManager instance caching
│   ├── session-manager-init.ts    # Session file initialization
│   ├── system-prompt.ts           # System prompt builder
│   ├── tool-split.ts              # Split tools into builtIn vs custom
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel mapping, error description
├── pi-embedded-subscribe.ts       # Session event subscription/dispatch
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # Event handler factory
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # Streaming block reply chunking
├── pi-embedded-messaging.ts       # Messaging tool sent tracking
├── pi-embedded-helpers.ts         # Error classification, turn validation
├── pi-embedded-helpers/           # Helper modules
├── pi-embedded-utils.ts           # Formatting utilities
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # AbortSignal wrapping for tools
├── pi-tools.policy.ts             # Tool allowlist/denylist policy
├── pi-tools.read.ts               # Read tool customizations
├── pi-tools.schema.ts             # Tool schema normalization
├── pi-tools.types.ts              # AnyAgentTool type alias
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition adapter
├── pi-settings.ts                 # Settings overrides
├── pi-extensions/                 # Custom pi extensions
│   ├── compaction-safeguard.ts    # Safeguard extension
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # Cache-TTL context pruning extension
│   └── context-pruning/
├── model-auth.ts                  # Auth profile resolution
├── auth-profiles.ts               # Profile store, cooldown, failover
├── model-selection.ts             # Default model resolution
├── models-config.ts               # models.json generation
├── model-catalog.ts               # Model catalog cache
├── context-window-guard.ts        # Context window validation
├── failover-error.ts              # FailoverError class
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # System prompt parameter resolution
├── system-prompt-report.ts        # Debug report generation
├── tool-summaries.ts              # Tool description summaries
├── tool-policy.ts                 # Tool policy resolution
├── transcript-policy.ts           # Transcript validation policy
├── skills.ts                      # Skill snapshot/prompt building
├── skills/                        # Skill subsystem
├── sandbox.ts                     # Sandbox context resolution
├── sandbox/                       # Sandbox subsystem
├── channel-tools.ts               # Channel-specific tool injection
├── openclaw-tools.ts              # OpenClaw-specific tools
├── bash-tools.ts                  # exec/process tools
├── apply-patch.ts                 # apply_patch tool (OpenAI)
├── tools/                         # Individual tool implementations
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── discord-actions*.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── slack-actions.ts
│   ├── telegram-actions.ts
│   ├── web-*.ts
│   └── whatsapp-actions.ts
└── ...
```

## Основной поток интеграции

### 1. Запуск встроенного агента

Основная точка входа — `runEmbeddedPiAgent()` в `pi-embedded-runner/run.ts`:

```typescript
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";

const result = await runEmbeddedPiAgent({
  sessionId: "user-123",
  sessionKey: "main:whatsapp:+1234567890",
  sessionFile: "/path/to/session.jsonl",
  workspaceDir: "/path/to/workspace",
  config: openclawConfig,
  prompt: "Hello, how are you?",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 2. Создание сеанса

Внутри `runEmbeddedAttempt()` (вызываемого из `runEmbeddedPiAgent()`) используется SDK pi:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedWorkspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  thinkingLevel: mapThinkingLevel(params.thinkLevel),
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});

applySystemPromptOverrideToSession(session, systemPromptOverride);
```

### 3. Подписка на события

`subscribeEmbeddedPiSession()` подписывается на события `AgentSession` pi:

```typescript
const subscription = subscribeEmbeddedPiSession({
  session: activeSession,
  runId: params.runId,
  verboseLevel: params.verboseLevel,
  reasoningMode: params.reasoningLevel,
  toolResultFormat: params.toolResultFormat,
  onToolResult: params.onToolResult,
  onReasoningStream: params.onReasoningStream,
  onBlockReply: params.onBlockReply,
  onPartialReply: params.onPartialReply,
  onAgentEvent: params.onAgentEvent,
});
```

Обрабатываемые события включают:

- `message_start` / `message_end` / `message_update` (потоковый вывод текста/мышления)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Промптинг

После настройки сеанс получает промпт:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK обрабатывает полный цикл агента: отправку в LLM, выполнение вызовов инструментов, потоковую передачу ответов.

## Архитектура инструментов

### Конвейер инструментов

1. **Базовые инструменты**: `codingTools` pi (read, bash, edit, write)
2. **Пользовательские замены**: OpenClaw заменяет bash на `exec`/`process`, настраивает read/edit/write для sandbox
3. **Инструменты OpenClaw**: сообщения, браузер, canvas, сеансы, cron, gateway и т. д.
4. **Инструменты каналов**: инструменты действий, специфичные для Discord/Telegram/Slack/WhatsApp
5. **Фильтрация политик**: инструменты фильтруются по профилю, провайдеру, агенту, группе и политикам sandbox
6. **Нормализация схем**: схемы очищаются с учётом особенностей Gemini/OpenAI
7. **Оборачивание AbortSignal**: инструменты оборачиваются для соблюдения сигналов прерывания

### Адаптер определения инструментов

`AgentTool` из pi-agent-core имеет другую сигнатуру `execute`, чем `ToolDefinition` из pi-coding-agent. Адаптер в `pi-tool-definition-adapter.ts` устраняет это различие:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent signature differs from pi-agent-core
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Стратегия разделения инструментов

`splitSdkTools()` передаёт все инструменты через `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

Это гарантирует, что фильтрация политик OpenClaw, интеграция sandbox и расширенный набор инструментов остаются согласованными между провайдерами.

## Построение системного промпта

Системный промпт формируется в `buildAgentSystemPrompt()` (`system-prompt.ts`). Он собирает полный промпт с разделами, включая Tooling, Tool Call Style, защитные ограничения безопасности, справочник OpenClaw CLI, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, метаданные выполнения, а также Memory и Reactions (при включении), и необязательные контекстные файлы и дополнительное содержимое системного промпта. Разделы сокращаются для минимального режима промпта, используемого субагентами.

Промпт применяется после создания сеанса через `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Управление сеансами

### Файлы сеансов

Сеансы — это файлы JSONL с древовидной структурой (связи id/parentId). Персистентность обрабатывается `SessionManager` pi:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw оборачивает это с помощью `guardSessionManager()` для обеспечения безопасности результатов инструментов.

### Кэширование сеансов

`session-manager-cache.ts` кэширует экземпляры SessionManager, чтобы избежать повторного парсинга файлов:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Ограничение истории

`limitHistoryTurns()` обрезает историю диалога в зависимости от типа канала (личные сообщения vs группы).

### Совместимость

Автоматическое уплотнение срабатывает при переполнении контекста. `compactEmbeddedPiSessionDirect()` обрабатывает ручное уплотнение:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Аутентификация и определение модели

### Профили аутентификации

OpenClaw поддерживает хранилище профилей аутентификации с несколькими ключами API для каждого провайдера:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Профили ротируются при сбоях с отслеживанием cooldown:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Определение модели

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);

// Uses pi's ModelRegistry and AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### Отказ

`FailoverError` инициирует переключение модели при соответствующей конфигурации:

```typescript
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
  throw new FailoverError(errorText, {
    reason: promptFailoverReason ?? "unknown",
    provider,
    model: modelId,
    profileId,
    status: resolveFailoverStatus(promptFailoverReason),
  });
}
```

## Расширения Pi

OpenClaw загружает пользовательские расширения pi для специализированного поведения:

### Гарантия уплотнения

`pi-extensions/compaction-safeguard.ts` добавляет защитные механизмы для уплотнения, включая адаптивное бюджетирование токенов, а также сводки по сбоям инструментов и операциям с файлами:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Прореживание контекста

`pi-extensions/context-pruning.ts` реализует прореживание контекста на основе TTL кэша:

```typescript
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens,
    isToolPrunable,
    lastCacheTouchAt,
  });
  paths.push(resolvePiExtensionPath("context-pruning"));
}
```

## Потоковая передача и блочные ответы

### Разбиение на блоки

`EmbeddedBlockChunker` управляет потоковой передачей текста в дискретные блоки ответа:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Удаление тегов Thinking/Final

Потоковый вывод обрабатывается для удаления блоков `<think>`/`<thinking>` и извлечения содержимого `<final>`:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Директивы ответа

Директивы ответа, такие как `[[media:url]]`, `[[voice]]`, `[[reply:id]]`, разбираются и извлекаются:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Обработка ошибок

### Классификация ошибок

`pi-embedded-helpers.ts` классифицирует ошибки для соответствующей обработки:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Резервный уровень мышления

Если уровень мышления не поддерживается, выполняется откат:

```typescript
const fallbackThinking = pickFallbackThinkingLevel({
  message: errorText,
  attempted: attemptedThinking,
});
if (fallbackThinking) {
  thinkLevel = fallbackThinking;
  continue;
}
```

## Интеграция sandbox

Когда включён режим sandbox, инструменты и пути ограничиваются:

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // Use sandboxed read/edit/write tools
  // Exec runs in container
  // Browser uses bridge URL
}
```

## Провайдер-специфичная обработка

### Anthropic

- Очистка magic string отказов
- Валидация ходов для последовательных ролей
- Совместимость параметров Claude Code

### Google/Gemini

- Исправления порядка ходов (`applyGoogleTurnOrderingFix`)
- Санитизация схем инструментов (`sanitizeToolsForGoogle`)
- Санитизация истории сеансов (`sanitizeSessionHistory`)

### OpenAI

- Инструмент `apply_patch` для моделей Codex
- Обработка понижения уровня мышления

## Интеграция TUI

OpenClaw также имеет локальный TUI-режим, который напрямую использует компоненты pi-tui:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Это обеспечивает интерактивный терминальный опыт, аналогичный нативному режиму pi.

## Ключевые отличия от Pi CLI

| Аспект            | Pi CLI                              | Встроенный OpenClaw                                                                                                |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Вызов             | команда `pi` / RPC                  | SDK через `createAgentSession()`                                                                                   |
| Инструменты       | Инструменты кодинга по умолчанию    | Пользовательский набор инструментов OpenClaw                                                                       |
| Системный промпт  | AGENTS.md + промпты | Динамический для каждого канала/контекста                                                                          |
| Хранилище сеансов | `~/.pi/agent/sessions/`             | `~/.openclaw/agents/<agentId>/sessions/` (или `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Аутентификация    | Одна учётная запись                 | Мультипрофильная с ротацией                                                                                        |
| Расширения        | Загружаются с диска                 | Программные + пути на диске                                                                                        |
| Обработка событий | Рендеринг TUI                       | На основе колбэков (onBlockReply и т. п.)                       |

## Будущие соображения

Области для потенциальной переработки:

1. **Выравнивание сигнатур инструментов**: в настоящее время используется адаптация между сигнатурами pi-agent-core и pi-coding-agent
2. **Оборачивание менеджера сеансов**: `guardSessionManager` повышает безопасность, но увеличивает сложность
3. **Загрузка расширений**: можно более напрямую использовать `ResourceLoader` pi
4. **Сложность обработчика стриминга**: `subscribeEmbeddedPiSession` значительно разросся
5. **Особенности провайдеров**: множество провайдер-специфичных кодовых путей, которые pi потенциально мог бы обрабатывать

## Тесты

Все существующие тесты, покрывающие интеграцию pi и её расширения:

- `src/agents/pi-embedded-block-chunker.test.ts`
- `src/agents/pi-embedded-helpers.buildbootstrapcontextfiles.test.ts`
- `src/agents/pi-embedded-helpers.classifyfailoverreason.test.ts`
- `src/agents/pi-embedded-helpers.downgradeopenai-reasoning.test.ts`
- `src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts`
- `src/agents/pi-embedded-helpers.formatrawassistanterrorforui.test.ts`
- `src/agents/pi-embedded-helpers.image-dimension-error.test.ts`
- `src/agents/pi-embedded-helpers.image-size-error.test.ts`
- `src/agents/pi-embedded-helpers.isautherrormessage.test.ts`
- `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts`
- `src/agents/pi-embedded-helpers.iscloudcodeassistformaterror.test.ts`
- `src/agents/pi-embedded-helpers.iscompactionfailureerror.test.ts`
- `src/agents/pi-embedded-helpers.iscontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.isfailovererrormessage.test.ts`
- `src/agents/pi-embedded-helpers.islikelycontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.ismessagingtoolduplicate.test.ts`
- `src/agents/pi-embedded-helpers.messaging-duplicate.test.ts`
- `src/agents/pi-embedded-helpers.normalizetextforcomparison.test.ts`
- `src/agents/pi-embedded-helpers.resolvebootstrapmaxchars.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.keeps-tool-call-tool-result-ids-unchanged.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.removes-empty-assistant-text-blocks-but-preserves.test.ts`
- `src/agents/pi-embedded-helpers.sanitizegoogleturnordering.test.ts`
- `src/agents/pi-embedded-helpers.sanitizesessionmessagesimages-thought-signature-stripping.test.ts`
- `src/agents/pi-embedded-helpers.sanitizetoolcallid.test.ts`
- `src/agents/pi-embedded-helpers.sanitizeuserfacingtext.test.ts`
- `src/agents/pi-embedded-helpers.stripthoughtsignatures.test.ts`
- `src/agents/pi-embedded-helpers.validate-turns.test.ts`
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (live)
- `src/agents/pi-embedded-runner-extraparams.test.ts`
- `src/agents/pi-embedded-runner.applygoogleturnorderingfix.test.ts`
- `src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts`
- `src/agents/pi-embedded-runner.createsystempromptoverride.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts`
- `src/agents/pi-embedded-runner.google-sanitize-thinking.test.ts`
- `src/agents/pi-embedded-runner.guard.test.ts`
- `src/agents/pi-embedded-runner.limithistoryturns.test.ts`
- `src/agents/pi-embedded-runner.resolvesessionagentids.test.ts`
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`
- `src/agents/pi-embedded-runner.sanitize-session-history.test.ts`
- `src/agents/pi-embedded-runner.splitsdktools.test.ts`
- `src/agents/pi-embedded-runner.test.ts`
- `src/agents/pi-embedded-subscribe.code-span-awareness.test.ts`
- `src/agents/pi-embedded-subscribe.reply-tags.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-call-onblockreplyflush-callback-is-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-emit-duplicate-block-replies-text.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-block-replies-text-end-does-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.filters-final-suppresses-output-without-start-tag.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.includes-canvas-action-metadata-tool-summaries.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.splits-long-single-line-fenced-blocks-reopen.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.suppresses-message-end-block-replies-message-tool.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.waits-multiple-compaction-retries-before-resolving.test.ts`
- `src/agents/pi-embedded-subscribe.tools.test.ts`
- `src/agents/pi-embedded-utils.test.ts`
- `src/agents/pi-extensions/compaction-safeguard.test.ts`
- `src/agents/pi-extensions/context-pruning.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-tools-agent-config.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-b.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-d.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-f.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts`
- `src/agents/pi-tools.policy.test.ts`
- `src/agents/pi-tools.safe-bins.test.ts`
- `src/agents/pi-tools.workspace-paths.test.ts`
