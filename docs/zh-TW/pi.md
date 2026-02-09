---
title: "Pi 整合架構"
---

# Pi 整合架構

本文件說明 OpenClaw 如何與 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 及其兄弟套件（`pi-ai`、`pi-agent-core`、`pi-tui`）整合，以驅動其 AI 代理程式能力。

## 概覽

OpenClaw 使用 pi SDK，將 AI 程式設計代理程式嵌入其訊息 Gateway 閘道器架構中。OpenClaw 並非以子行程方式啟動 pi，或使用 RPC 模式，而是透過 `createAgentSession()` 直接匯入並實例化 pi 的 `AgentSession`。此種嵌入式方式提供： Instead of spawning pi as a subprocess or using RPC mode, OpenClaw directly imports and instantiates pi's `AgentSession` via `createAgentSession()`. This embedded approach provides:

- 對工作階段生命週期與事件處理的完整控制
- 自訂工具注入（訊息、沙箱、頻道專屬動作）
- 依頻道／情境調整的系統提示
- Session persistence with branching/compaction support
- 具備故障轉移的多帳號驗證設定檔輪替
- 與供應商無關的模型切換

## 套件相依性

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| 套件                | 用途                                                                              |
| ----------------- | ------------------------------------------------------------------------------- |
| `pi-ai`           | 核心 LLM 抽象：`Model`、`streamSimple`、訊息型別、提供者 API                                   |
| `pi-agent-core`   | 代理程式迴圈、工具執行、`AgentMessage` 型別                                                   |
| `pi-coding-agent` | 高階 SDK：`createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、內建工具 |
| `pi-tui`          | 終端機 UI 元件（用於 OpenClaw 的本機 TUI 模式）                                               |

## 檔案結構

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

## 核心整合流程

### 1. 執行嵌入式代理程式

主要進入點為 `pi-embedded-runner/run.ts` 中的 `runEmbeddedPiAgent()`：

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

### 2. 工作階段建立

在 `runEmbeddedAttempt()` 中（由 `runEmbeddedPiAgent()` 呼叫），會使用 pi SDK：

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

### 3. 事件訂閱

`subscribeEmbeddedPiSession()` 訂閱 pi 的 `AgentSession` 事件：

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

處理的事件包含：

- `message_start` / `message_end` / `message_update`（串流文字／思考）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 提示

完成設定後，會對工作階段下達提示：

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK 會處理完整的代理程式迴圈：傳送至 LLM、執行工具呼叫、串流回應。

## 工具架構

### 工具管線

1. **基礎工具**：pi 的 `codingTools`（read、bash、edit、write）
2. **自訂替換**：OpenClaw 以 `exec`/`process` 取代 bash，並針對沙箱客製化 read/edit/write
3. **OpenClaw 工具**：訊息、瀏覽器、畫布、工作階段、cron、Gateway 閘道器等
4. **頻道工具**：Discord／Telegram／Slack／WhatsApp 專屬動作工具
5. **政策過濾**：依設定檔、提供者、代理程式、群組、沙箱政策過濾工具
6. **結構綱要正規化**：清理結構綱要以因應 Gemini／OpenAI 的差異
7. **AbortSignal 包裝**：包裝工具以遵循中止訊號

### 工具定義轉接器

pi-agent-core 的 `AgentTool` 與 pi-coding-agent 的 `ToolDefinition` 在 `execute` 簽章上不同。位於 `pi-tool-definition-adapter.ts` 的轉接器負責銜接兩者： The adapter in `pi-tool-definition-adapter.ts` bridges this:

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

### 工具拆分策略

`splitSdkTools()` 透過 `customTools` 傳遞所有工具：

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

這可確保 OpenClaw 的政策過濾、沙箱整合，以及延伸工具集在各提供者之間保持一致。

## 系統提示建構

系統提示在 `buildAgentSystemPrompt()`（`system-prompt.ts`）中建構。其組合完整提示，包含 Tooling、Tool Call Style、安全防護、OpenClaw CLI 參考、Skills、文件、Workspace、Sandbox、Messaging、Reply Tags、Voice、Silent Replies、Heartbeats、執行期中繼資料，以及在啟用時的 Memory 與 Reactions，並可加入選用的情境檔案與額外系統提示內容。各區段在供子代理程式使用的最小提示模式下會被裁剪。 它會組裝包含多個區段的完整提示詞，包括 Tooling、Tool Call Style、安全防護欄、OpenClaw CLI 參考、Skills、Docs、Workspace、Sandbox、Messaging、Reply Tags、Voice、Silent Replies、Heartbeats、Runtime 中繼資料，以及在啟用時的 Memory 與 Reactions，並可選擇性加入情境檔案與額外的系統提示內容。 在子代理使用的最小提示模式中，區段會被裁剪。

提示會在建立工作階段後，透過 `applySystemPromptOverrideToSession()` 套用：

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## 工作階段管理

### 工作階段檔案

工作階段為具備樹狀結構（id/parentId 連結）的 JSONL 檔案。pi 的 `SessionManager` 負責持久化： Pi's `SessionManager` handles persistence:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw 以 `guardSessionManager()` 進行包裝，以確保工具結果安全。

### 工作階段快取

`session-manager-cache.ts` 快取 SessionManager 實例，以避免重複解析檔案：

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 歷史限制

`limitHistoryTurns()` 會依頻道型別（私訊 vs 群組）修剪對話歷史。

### 壓縮

Auto-compaction triggers on context overflow. 在情境溢位時會自動觸發壓縮。`compactEmbeddedPiSessionDirect()` 負責手動壓縮：

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 驗證與模型解析

### 驗證設定檔

OpenClaw 維護一個驗證設定檔儲存庫，每個提供者可包含多組 API 金鑰：

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profiles rotate on failures with cooldown tracking:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### 模型解析

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

### 失敗接手

在設定啟用時，`FailoverError` 會觸發模型後備：

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

## Pi 擴充

OpenClaw 會載入自訂的 pi 擴充，以提供專門行為：

### 壓縮防護機制

`pi-extensions/compaction-safeguard.ts` 為壓縮加入防護措施，包含自適應權杖預算，以及工具失敗與檔案操作摘要：

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context Pruning

`pi-extensions/context-pruning.ts` 實作基於快取 TTL 的情境修剪：

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

## 串流與區塊回覆

### 區塊分段

`EmbeddedBlockChunker` 負責將串流文字管理為離散的回覆區塊：

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 思考／最終標籤移除

串流輸出會經處理以移除 `<think>`/`<thinking>` 區塊，並擷取 `<final>` 內容：

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### 回覆指令

會解析並擷取如 `[[media:url]]`、`[[voice]]`、`[[reply:id]]` 等回覆指令：

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## 錯誤處理

### 錯誤分類

`pi-embedded-helpers.ts` 會分類錯誤以進行適當處理：

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 思考層級後備

若思考層級不受支援，將會回退：

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

## 沙箱整合

當啟用沙箱模式時，工具與路徑會受到限制：

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

## 供應商特定處理

### Anthropic

- 清理拒絕用的魔術字串
- 連續角色的回合驗證
- Claude Code 參數相容性

### Google/Gemini

- 回合順序修正（`applyGoogleTurnOrderingFix`）
- 工具結構綱要清理（`sanitizeToolsForGoogle`）
- 工作階段歷史清理（`sanitizeSessionHistory`）

### OpenAI

- 供 Codex 模型使用的 `apply_patch` 工具
- 思考層級降級處理

## TUI 整合

OpenClaw 亦提供使用 pi-tui 元件的本機 TUI 模式：

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

這可提供類似 pi 原生模式的互動式終端體驗。

## 與 Pi CLI 的主要差異

| 面向     | Pi CLI                         | OpenClaw 嵌入式                                                                                 |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------- |
| 呼叫方式   | `pi` 指令／RPC                    | 透過 `createAgentSession()` 的 SDK                                                              |
| 工具     | Default coding tools           | 自訂 OpenClaw 工具套件                                                                             |
| 系統提示   | AGENTS.md + 提示 | 依頻道／情境動態生成                                                                                   |
| 工作階段儲存 | `~/.pi/agent/sessions/`        | `~/.openclaw/agents/<agentId>/sessions/`（或 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`） |
| Auth   | 單一憑證                           | Multi-profile with rotation                                                                  |
| 擴充     | 從磁碟載入                          | 程式化 + 磁碟路徑                                                                                   |
| 事件處理   | TUI 繪製                         | 以回呼為基礎（onBlockReply 等）                                                                       |

## 未來考量

可能需要重構的領域：

1. **工具簽章對齊**：目前在 pi-agent-core 與 pi-coding-agent 簽章之間進行轉接
2. **工作階段管理器包裝**：`guardSessionManager` 增加安全性但提高複雜度
3. **擴充載入**：可更直接使用 pi 的 `ResourceLoader`
4. **串流處理器複雜度**：`subscribeEmbeddedPiSession` 已變得相當龐大
5. **提供者差異**：存在大量提供者專屬程式碼路徑，理論上可由 pi 處理

## 測試

所有涵蓋 pi 整合及其擴充的既有測試：

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
- `src/agents/pi-embedded-runner-extraparams.live.test.ts`（live）
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
