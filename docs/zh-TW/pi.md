---
title: "Pi 整合架構"
---

# Pi 整合架構

本檔案說明 OpenClaw 如何與 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 及其相關套件（`pi-ai`、`pi-agent-core`、`pi-tui`）整合，以驅動其 AI 智慧代理功能。

## 總覽

OpenClaw 使用 Pi SDK 將 AI 程式碼編寫智慧代理嵌入其訊息 Gateway 架構中。OpenClaw 並非將 Pi 作為子程序啟動或使用 RPC 模式，而是直接匯入並透過 `createAgentSession()` 實例化 Pi 的 `AgentSession`。這種嵌入式方法提供：

- 完整控制工作階段生命週期與事件處理
- 自定義工具注入（訊息、沙箱、頻道特定操作）
- 按頻道/上下文進行系統提示詞自定義
- 支援分支/壓縮的工作階段持久化
- 具備容錯移轉的多帳號驗證設定檔輪替
- 獨立於供應商的模型切換

## 套件相依性

```json
{
  " @mariozechner/pi-agent-core": "0.49.3",
  " @mariozechner/pi-ai": "0.49.3",
  " @mariozechner/pi-coding-agent": "0.49.3",
  " @mariozechner/pi-tui": "0.49.3"
}
```

| 套件              | 用途                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `pi-ai`           | 核心 LLM 抽象：`Model`、`streamSimple`、訊息類型、供應商 API                               |
| `pi-agent-core`   | 智慧代理迴圈、工具執行、`AgentMessage` 類型                                                |
| `pi-coding-agent` | 高階 SDK：`createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、內建工具 |
| `pi-tui`          | 終端機 UI 元件（用於 OpenClaw 的本地 TUI 模式）                                            |

## 檔案結構

```
src/agents/
├── pi-embedded-runner.ts          # 從 pi-embedded-runner/ 重新匯出
├── pi-embedded-runner/
│   ├── run.ts                     # 主要入口：runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # 包含工作階段設定的單次嘗試邏輯
│   │   ├── params.ts              # runEmbeddedPiAgentParams 類型
│   │   ├── payloads.ts            # 從執行結果構建回應酬載 (payloads)
│   │   ├── images.ts              # 視覺模型圖片注入
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # 中止錯誤偵測
│   ├── cache-ttl.ts               # 上下文修剪的快取 TTL 追蹤
│   ├── compact.ts                 # 手動/自動壓縮邏輯
│   ├── extensions.ts              # 載入嵌入式執行的 Pi 擴充功能
│   ├── extra-params.ts            # 供應商特定的串流參數
│   ├── google.ts                  # Google/Gemini 輪次排序修復
│   ├── history.ts                 # 歷史紀錄限制（私訊 vs 群組）
│   ├── lanes.ts                   # 工作階段/全域指令通道
│   ├── logger.ts                  # 子系統記錄器
│   ├── model.ts                   # 透過 ModelRegistry 解析模型
│   ├── runs.ts                    # 活動執行追蹤、中止、佇列
│   ├── sandbox-info.ts            # 系統提示詞的沙箱資訊
│   ├── session-manager-cache.ts   # SessionManager 實例快取
│   ├── session-manager-init.ts    # 工作階段檔案初始化
│   ├── system-prompt.ts           # 系統提示詞構建器
│   ├── tool-split.ts              # 將工具拆分為內建與自定義
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel 對應、錯誤描述
├── pi-embedded-subscribe.ts       # 工作階段事件訂閱/分發
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # 事件處理器工廠
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # 串流區塊回覆分塊
├── pi-embedded-messaging.ts       # 訊息工具傳送追蹤
├── pi-embedded-helpers.ts         # 錯誤分類、輪次驗證
├── pi-embedded-helpers/           # 輔助模組
├── pi-embedded-utils.ts           # 格式化公用程式
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # 工具的中止訊號封裝
├── pi-tools.policy.ts             # 工具允許列表/拒絕列表策略
├── pi-tools.read.ts               # 讀取工具自定義
├── pi-tools.schema.ts             # 工具結構描述標準化
├── pi-tools.types.ts              # AnyAgentTool 類型別名
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition 轉接器
├── pi-settings.ts                 # 設定覆寫
├── pi-extensions/                 # 自定義 Pi 擴充功能
│   ├── compaction-safeguard.ts    # 安全防護擴充功能
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # 基於快取 TTL 的上下文修剪擴充功能
│   └── context-pruning/
├── model-auth.ts                  # 驗證設定檔解析
├── auth-profiles.ts               # 設定檔儲存、冷卻、容錯移轉
├── model-selection.ts             # 預設模型解析
├── models-config.ts               # models.json 產生
├── model-catalog.ts               # 模型目錄快取
├── context-window-guard.ts        # 上下文視窗驗證
├── failover-error.ts              # FailoverError 類別
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # 系統提示詞參數解析
├── system-prompt-report.ts        # 偵錯報告產生
├── tool-summaries.ts              # 工具描述摘要
├── tool-policy.ts                 # 工具策略解析
├── transcript-policy.ts           # 對話紀錄驗證策略
├── skills.ts                      # Skill 快照/提示詞構建
├── skills/                        # Skill 子系統
├── sandbox.ts                     # 沙箱上下文解析
├── sandbox/                       # 沙箱子系統
├── channel-tools.ts               # 頻道特定工具注入
├── openclaw-tools.ts              # OpenClaw 特定工具
├── bash-tools.ts                  # exec/process 工具
├── apply-patch.ts                 # apply_patch 工具 (OpenAI)
├── tools/                         # 個別工具實作
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

### 1. 執行嵌入式智慧代理

主要的進入點是 `pi-embedded-runner/run.ts` 中的 `runEmbeddedPiAgent()`：

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

在 `runEmbeddedAttempt()`（由 `runEmbeddedPiAgent()` 呼叫）內部，使用了 Pi SDK：

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from " @mariozechner/pi-coding-agent";

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

`subscribeEmbeddedPiSession()` 訂閱 Pi 的 `AgentSession` 事件：

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

- `message_start` / `message_end` / `message_update`（串流文字/思考）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 提示 (Prompting)

設定完成後，對工作階段進行提示：

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK 會處理完整的智慧代理迴圈：發送到 LLM、執行工具呼叫、串流回應。

## 工具架構

### 工具管線

1. **基礎工具**：Pi 的 `codingTools`（read, bash, edit, write）
2. **自定義替代**：OpenClaw 將 bash 替換為 `exec`/`process`，並為沙箱自定義 read/edit/write
3. **OpenClaw 工具**：訊息、瀏覽器、畫布 (canvas)、工作階段、cron、gateway 等
4. **頻道工具**：Discord/Telegram/Slack/WhatsApp 特定的操作工具
5. **策略過濾**：根據設定檔、供應商、智慧代理、群組、沙箱策略過濾工具
6. **結構描述標準化**：針對 Gemini/OpenAI 的特殊處理清理結構描述 (Schemas)
7. **中止訊號封裝**：封裝工具以遵守中止訊號

### 工具定義轉接器

pi-agent-core 的 `AgentTool` 與 pi-coding-agent 的 `ToolDefinition` 有不同的 `execute` 特徵標記 (signature)。`pi-tool-definition-adapter.ts` 中的轉接器橋接了這一點：

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent 的簽署與 pi-agent-core 不同
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
    builtInTools: [], // 空值。我們覆寫所有內容
    customTools: toToolDefinitions(options.tools),
  };
}
```

這確保了 OpenClaw 的策略過濾、沙箱整合以及擴充工具集在不同供應商之間保持一致。

## 系統提示詞構建

系統提示詞在 `buildAgentSystemPrompt()`（`system-prompt.ts`）中構建。它組裝了一個完整的提示詞，包含：工具使用、工具呼叫風格、安全防護、OpenClaw CLI 參考、Skills、文件、工作區、沙箱、訊息傳送、回覆標籤、語音、靜默回覆、心跳、執行階段元數據，以及啟用的記憶與反應，還有選用的上下文檔案和額外的系統提示內容。對於子智慧代理使用的極簡提示模式，相關區塊會被修剪。

提示詞在工作階段建立後透過 `applySystemPromptOverrideToSession()` 應用：

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## 工作階段管理

### 工作階段檔案

工作階段是具有樹狀結構（id/parentId 連結）的 JSONL 檔案。Pi 的 `SessionManager` 處理持久化：

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw 使用 `guardSessionManager()` 封裝此功能以確保工具結果的安全。

### 工作階段快取

`session-manager-cache.ts` 快取 SessionManager 實例以避免重複解析檔案：

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 歷史紀錄限制

`limitHistoryTurns()` 根據頻道類型（私訊 vs 群組）修剪對話歷史紀錄。

### 壓縮 (Compaction)

當上下文溢位時會觸發自動壓縮。`compactEmbeddedPiSessionDirect()` 處理手動壓縮：

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 驗證與模型解析

### 驗證設定檔 (Auth Profiles)

OpenClaw 為每個供應商維護一個包含多個 API 金鑰的驗證設定檔儲存庫：

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

設定檔在失敗時會輪替，並具備冷卻追蹤功能：

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

// 使用 Pi 的 ModelRegistry 與 AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### 容錯移轉 (Failover)

設定後，`FailoverError` 會觸發模型回退 (fallback)：

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

OpenClaw 載入自定義 Pi 擴充功能以實現特殊行為：

### 壓縮安全防護 (Compaction Safeguard)

`pi-extensions/compaction-safeguard.ts` 為壓縮功能增加安全防護，包括自適應權杖預算，以及工具失敗與檔案操作摘要：

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### 上下文修剪 (Context Pruning)

`pi-extensions/context-pruning.ts` 實作了基於快取 TTL 的上下文修剪：

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

### 區塊分塊 (Block Chunking)

`EmbeddedBlockChunker` 管理將串流文字分塊為獨立的回覆區塊：

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 思考/最終標籤去除

處理串流輸出以去除 `<think>`/`<thinking>` 區塊並提取 `<final>` 內容：

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // 去除 <think>...</think> 內容
  // 如果強制執行 final 標籤，則僅傳回 <final>...</final> 內容
};
```

### 回覆指令

解析並提取回覆指令，例如 `[[media:url]]`、`[[voice]]`、`[[reply:id]]`：

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## 錯誤處理

### 錯誤分類

`pi-embedded-helpers.ts` 對錯誤進行分類以便適當處理：

```typescript
isContextOverflowError(errorText)     // 上下文過大
isCompactionFailureError(errorText)   // 壓縮失敗
isAuthAssistantError(lastAssistant)   // 驗證失敗
isRateLimitAssistantError(...)        // 速率限制
isFailoverAssistantError(...)         // 應進行容錯移轉
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 思考層級回退 (Thinking Level Fallback)

如果不支持某個思考層級，它會回退：

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

啟用沙箱模式時，工具和路徑會受到約束：

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // 使用沙箱隔離的 read/edit/write 工具
  // Exec 在容器中執行
  // 瀏覽器使用橋接 URL
}
```

## 供應商特定處理

### Anthropic

- 拒絕魔術字串過濾
- 連續角色的輪次驗證
- Claude Code 參數相容性

### Google/Gemini

- 輪次排序修復 (`applyGoogleTurnOrderingFix`)
- 工具結構描述清理 (`sanitizeToolsForGoogle`)
- 工作階段歷史紀錄清理 (`sanitizeSessionHistory`)

### OpenAI

- 用於 Codex 模型的 `apply_patch` 工具
- 思考層級降級處理

## TUI 整合

OpenClaw 也有一個本地 TUI 模式，直接使用 pi-tui 元件：

```typescript
// src/tui/tui.ts
import { ... } from " @mariozechner/pi-tui";
```

這提供了類似於 Pi 原生模式的互動式終端機體驗。

## 與 Pi CLI 的主要差異

| 面向         | Pi CLI                  | OpenClaw 嵌入式                                                                                |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------- |
| 調用方式     | `pi` 指令 / RPC         | 透過 `createAgentSession()` 調用 SDK                                                           |
| 工具         | 預設程式碼編寫工具      | 自定義 OpenClaw 工具套件                                                                       |
| 系統提示詞   | AGENTS.md + 提示詞      | 按頻道/上下文動態產生                                                                          |
| 工作階段儲存 | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/` (或 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| 驗證         | 單一憑證                | 具備輪替功能的多設定檔                                                                         |
| 擴充功能     | 從磁碟載入              | 程式化 + 磁碟路徑                                                                              |
| 事件處理     | TUI 渲染                | 基於回呼 (Callback)（onBlockReply 等）                                                         |

## 未來考量

可能需要重構的部分：

1. **工具簽署對齊**：目前在 pi-agent-core 與 pi-coding-agent 的簽署之間進行轉換
2. **工作階段管理員封裝**：`guardSessionManager` 增加了安全性但提高了複雜度
3. **擴充功能載入**：可以更直接地使用 Pi 的 `ResourceLoader`
4. **串流處理器複雜性**：`subscribeEmbeddedPiSession` 變得過於龐大
5. **供應商特殊行為**：許多供應商特定的程式碼路徑，Pi 可能可以處理

## 測試

所有涵蓋 Pi 整合及其擴充功能的現有測試：

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
- `src/agents/pi-embedded-
