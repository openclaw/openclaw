---
title: Pi Integration Architecture
summary: Architecture of OpenClaw's embedded Pi agent integration and session lifecycle
read_when:
  - Understanding Pi SDK integration design in OpenClaw
  - "Modifying agent session lifecycle, tooling, or provider wiring for Pi"
---

# Pi 整合架構

本文件說明 OpenClaw 如何與 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 及其相關套件 (`pi-ai`, `pi-agent-core`, `pi-tui`) 整合，以驅動其 AI 代理功能。

## 概覽

OpenClaw 使用 pi SDK 將 AI 程式碼代理嵌入其訊息閘道架構中。OpenClaw 並非以子程序方式啟動 pi 或使用 RPC 模式，而是直接透過 `createAgentSession()` 匯入並實例化 pi 的 `AgentSession`。此嵌入式方式提供：

- 完整掌控會話生命週期與事件處理
- 自訂工具注入（訊息、沙盒、頻道專屬操作）
- 依頻道/上下文自訂系統提示
- 支援分支與壓縮的會話持久化
- 多帳號認證設定輪替與故障轉移
- 不依賴特定供應商的模型切換

## 套件依賴

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| 套件              | 功能說明                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `pi-ai`           | 核心大型語言模型抽象：`Model`, `streamSimple`, 訊息類型，供應商 API                        |
| `pi-agent-core`   | 代理循環、工具執行、`AgentMessage` 類型                                                    |
| `pi-coding-agent` | 高階 SDK：`createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`，內建工具 |
| `pi-tui`          | 終端機 UI 元件（用於 OpenClaw 的本地 TUI 模式）                                            |

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

### 1. 執行嵌入式代理

主要進入點為 `runEmbeddedPiAgent()`，位於 `pi-embedded-runner/run.ts`：

typescript
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

### 2. 會話建立

在 `runEmbeddedAttempt()`（由 `runEmbeddedPiAgent()` 呼叫）中，使用了 pi SDK：

typescript
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

處理的事件包括：

- `message_start` / `message_end` / `message_update`（串流文字／思考中）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 提示輸入

設定完成後，對會話進行提示：

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK 負責完整的代理循環：發送給 LLM、執行工具呼叫、串流回應。

影像注入是提示本地的：OpenClaw 從當前提示載入影像參考，並僅在該回合透過 `images` 傳遞。它不會重新掃描較舊的歷史回合來重新注入影像載荷。

## 工具架構

### 工具流程

1. **基礎工具**：pi 的 `codingTools`（讀取、bash、編輯、寫入）
2. **自訂替換**：OpenClaw 用 `exec`/`process` 替換 bash，並為沙盒自訂讀取/編輯/寫入
3. **OpenClaw 工具**：訊息、瀏覽器、畫布、會話、排程、閘道等
4. **頻道工具**：Discord/Telegram/Slack/WhatsApp 專用動作工具
5. **政策過濾**：依照設定檔、提供者、代理、群組、沙盒政策過濾工具
6. **結構標準化**：針對 Gemini/OpenAI 特性清理結構
7. **AbortSignal 包裝**：工具包裝以支援中止信號

### 工具定義轉接器

pi-agent-core 的 `AgentTool` 與 pi-coding-agent 的 `ToolDefinition` 有不同的 `execute` 簽名。`pi-tool-definition-adapter.ts` 中的轉接器負責橋接此差異：

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

這確保 OpenClaw 的政策過濾、沙盒整合與擴充工具集在各提供者間保持一致。

## 系統提示建構

系統提示在 `buildAgentSystemPrompt()`（`system-prompt.ts`）中建構。它組合完整提示，包含工具、工具呼叫方式、安全防護、OpenClaw CLI 參考、技能、文件、工作區、沙盒、訊息、回覆標籤、語音、靜默回覆、心跳、執行時元資料，以及啟用時的記憶與反應，還有可選的上下文檔案與額外系統提示內容。子代理使用的最小提示模式會修剪這些區段。

提示在會話建立後透過 `applySystemPromptOverrideToSession()` 應用：

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## 會話管理

### 會話檔案

會話是具有樹狀結構（id/parentId 連結）的 JSONL 檔案。Pi 的 `SessionManager` 負責持久化：

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw 使用 `guardSessionManager()` 封裝此功能，以確保工具結果的安全性。

### 會話快取

`session-manager-cache.ts` 快取 SessionManager 實例，避免重複解析檔案：

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 歷史限制

`limitHistoryTurns()` 根據頻道類型（私訊 vs 群組）修剪對話歷史。

### 壓縮

當上下文溢出時會自動觸發壓縮。`compactEmbeddedPiSessionDirect()` 負責手動壓縮：

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 認證與模型解析

### 認證設定檔

OpenClaw 維護一個包含多個供應商 API 金鑰的認證設定檔庫：

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

設定檔在失敗時會輪替，並追蹤冷卻時間：

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### 模型解析

typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
provider,
modelId,
agentDir,
config,
);

// 使用 pi 的 ModelRegistry 和 AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);

### 故障切換

`FailoverError` 在設定時會觸發模型回退：

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

## Pi 擴充功能

OpenClaw 載入自訂的 pi 擴充功能以實現專門行為：

### 壓縮保護機制

`src/agents/pi-extensions/compaction-safeguard.ts` 為壓縮添加防護措施，包括自適應 token 預算，以及工具失敗和檔案操作摘要：

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### 上下文修剪

`src/agents/pi-extensions/context-pruning.ts` 實作了基於快取 TTL 的上下文修剪：

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

### 區塊切割

`EmbeddedBlockChunker` 負責將串流文字管理成離散的回覆區塊：

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 思考/最終標籤剝除

串流輸出會被處理以剝除 `<think>`/`<thinking>` 區塊並擷取 `<final>` 內容：

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### 回覆指令

會解析並擷取像 `[[media:url]]`、`[[voice]]`、`[[reply:id]]` 這類的回覆指令：

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## 錯誤處理

### 錯誤分類

`pi-embedded-helpers.ts` 用於分類錯誤以便適當處理：

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 思考層級回退

若思考層級不被支援，則會回退：

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

## 沙盒整合

啟用沙盒模式時，工具與路徑會受到限制：

typescript
const sandbox = await resolveSandboxContext({
config: params.config,
sessionKey: sandboxSessionKey,
workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
// 使用沙盒化的讀取/編輯/寫入工具
// Exec 在容器中執行
// 瀏覽器使用橋接 URL
}

## 供應商特定處理

### Anthropic

- 拒絕魔術字串清理
- 連續角色的回合驗證
- Claude Code 參數相容性

### Google/Gemini

- 回合排序修正 (`applyGoogleTurnOrderingFix`)
- 工具結構清理 (`sanitizeToolsForGoogle`)
- 會話歷史清理 (`sanitizeSessionHistory`)

### OpenAI

- `apply_patch` Codex 模型的工具
- 思考層級降級處理

## TUI 整合

OpenClaw 也有一個本地 TUI 模式，直接使用 pi-tui 元件：

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

這提供了類似 pi 原生模式的互動式終端體驗。

## 與 Pi CLI 的主要差異

| 方面     | Pi CLI                  | OpenClaw 嵌入式                                                                                 |
| -------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| 呼叫方式 | `pi` 指令 / RPC         | 透過 SDK 使用 `createAgentSession()`                                                            |
| 工具     | 預設程式編碼工具        | 自訂 OpenClaw 工具套件                                                                          |
| 系統提示 | AGENTS.md + 提示語      | 依頻道/上下文動態調整                                                                           |
| 會話儲存 | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/`（或 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`） |
| 認證     | 單一憑證                | 多重設定檔並支援輪替                                                                            |
| 擴充功能 | 從磁碟載入              | 程式化 + 磁碟路徑                                                                               |
| 事件處理 | TUI 渲染                | 基於回呼函式（如 onBlockReply 等）                                                              |

## 未來考量

潛在重構方向：

1. **工具簽名對齊**：目前在 pi-agent-core 與 pi-coding-agent 簽名間做調整
2. **會話管理包裝**：`guardSessionManager` 增加安全性但也提高複雜度
3. **擴充功能載入**：可更直接使用 pi 的 `ResourceLoader`
4. **串流處理器複雜度**：`subscribeEmbeddedPiSession` 已變得龐大
5. **供應商特性**：許多供應商專屬的程式碼路徑，pi 可能能統一處理

## 測試

Pi 整合涵蓋以下測試套件：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-auth-json.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-embedded-helpers*.test.ts`
- `src/agents/pi-embedded-runner*.test.ts`
- `src/agents/pi-embedded-runner/**/*.test.ts`
- `src/agents/pi-embedded-subscribe*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-tool-definition-adapter*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-extensions/**/*.test.ts`

實況/選擇性參與：

- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (啟用 `OPENCLAW_LIVE_TEST=1`)

有關目前執行的指令，請參閱 [Pi 開發工作流程](/pi-dev)。
