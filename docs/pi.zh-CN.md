---
title: "Pi 集成架构"
summary: "OpenClaw 的嵌入式 Pi 代理集成和会话生命周期的架构"
read_when:
  - 理解 OpenClaw 中的 Pi SDK 集成设计
  - 为 Pi 修改代理会话生命周期、工具或提供程序连接
---

# Pi 集成架构

本文档描述 OpenClaw 如何与 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 及其姊妹包（`pi-ai`、`pi-agent-core`、`pi-tui`）集成，以提供其 AI 代理功能。

## 概述

OpenClaw 使用 pi SDK 将 AI 编码代理嵌入其消息网关架构中。OpenClaw 不是将 pi 作为子进程生成或使用 RPC 模式，而是通过 `createAgentSession()` 直接导入和实例化 pi 的 `AgentSession`。这种嵌入式方法提供：

- 对会话生命周期和事件处理的完全控制
- 自定义工具注入（消息、沙箱、渠道特定操作）
- 每个渠道/上下文的系统提示自定义
- 具有分支/压缩支持的会话持久化
- 具有故障转移的多帐户身份验证配置文件轮换
- 与提供程序无关的模型切换

## 包依赖关系

```json
{
  "@mariozechner/pi-agent-core": "0.64.0",
  "@mariozechner/pi-ai": "0.64.0",
  "@mariozechner/pi-coding-agent": "0.64.0",
  "@mariozechner/pi-tui": "0.64.0"
}
```

| 包                | 用途                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `pi-ai`           | 核心 LLM 抽象：`Model`、`streamSimple`、消息类型、提供程序 API                             |
| `pi-agent-core`   | 代理循环、工具执行、`AgentMessage` 类型                                                    |
| `pi-coding-agent` | 高级 SDK：`createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、内置工具 |
| `pi-tui`          | 终端 UI 组件（用于 OpenClaw 的本地 TUI 模式）                                              |

## 文件结构

```
src/agents/
├── pi-embedded-runner.ts          # 从 pi-embedded-runner/ 重新导出
├── pi-embedded-runner/
│   ├── run.ts                     # 主入口：runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # 带会话设置的单次尝试逻辑
│   │   ├── params.ts              # RunEmbeddedPiAgentParams 类型
│   │   ├── payloads.ts            # 从运行结果构建响应负载
│   │   ├── images.ts              # 视觉模型图像注入
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # 中止错误检测
│   ├── cache-ttl.ts               # 上下文压缩的缓存 TTL 跟踪
│   ├── compact.ts                 # 手动/自动压缩逻辑
│   ├── extensions.ts              # 为嵌入式运行加载 pi 扩展
│   ├── extra-params.ts            # 提供程序特定的流参数
│   ├── google.ts                  # Google/Gemini 轮次排序修复
│   ├── history.ts                 # 历史限制（DM 与群组）
│   ├── lanes.ts                   # 会话/全局命令通道
│   ├── logger.ts                  # 子系统记录器
│   ├── model.ts                   # 通过 ModelRegistry 的模型解析
│   ├── runs.ts                    # 活动运行跟踪、中止、队列
│   ├── sandbox-info.ts            # 系统提示的沙箱信息
│   ├── session-manager-cache.ts   # SessionManager 实例缓存
│   ├── session-manager-init.ts    # 会话文件初始化
│   ├── system-prompt.ts           # 系统提示构建器
│   ├── tool-split.ts              # 将工具拆分为内置与自定义
│   ├── types.ts                   # EmbeddedPiAgentMeta、EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel 映射、错误描述
├── pi-embedded-subscribe.ts       # 会话事件订阅/分派
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # 事件处理程序工厂
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # 流式块回复分块
├── pi-embedded-messaging.ts       # 消息工具发送跟踪
├── pi-embedded-helpers.ts         # 错误分类、轮次验证
├── pi-embedded-helpers/           # 帮助模块
├── pi-embedded-utils.ts           # 格式化实用程序
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # 工具的 AbortSignal 包装
├── pi-tools.policy.ts             # 工具允许/拒绝列表策略
├── pi-tools.read.ts               # Read 工具自定义
├── pi-tools.schema.ts             # 工具模式规范化
├── pi-tools.types.ts              # AnyAgentTool 类型别名
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition 适配器
├── pi-settings.ts                 # 设置覆盖
├── pi-hooks/                      # 自定义 pi 钩子
│   ├── compaction-safeguard.ts    # 防护扩展
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # 基于缓存 TTL 的上下文压缩扩展
│   └── context-pruning/
├── model-auth.ts                  # 身份验证配置文件解析
├── auth-profiles.ts               # 配置文件存储、冷却、故障转移
├── model-selection.ts             # 默认模型解析
├── models-config.ts               # models.json 生成
├── model-catalog.ts               # 模型目录缓存
├── context-window-guard.ts        # 上下文窗口验证
├── failover-error.ts              # FailoverError 类
├── defaults.ts                    # DEFAULT_PROVIDER、DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # 系统提示参数解析
├── system-prompt-report.ts        # 调试报告生成
├── tool-summaries.ts              # 工具描述摘要
├── tool-policy.ts                 # 工具策略解析
├── transcript-policy.ts           # 转录验证策略
├── skills.ts                      # 技能快照/提示构建
├── skills/                        # 技能子系统
├── sandbox.ts                     # 沙箱上下文解析
├── sandbox/                       # 沙箱子系统
├── channel-tools.ts               # 渠道特定工具注入
├── openclaw-tools.ts              # OpenClaw 特定工具
├── bash-tools.ts                  # exec/process 工具
├── apply-patch.ts                 # apply_patch 工具（OpenAI）
├── tools/                         # 单个工具实现
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── web-*.ts
│   └── ...
└── ...
```

渠道特定的消息操作运行时现在位于插件拥有的扩展目录中，而不是 `src/agents/tools` 下，例如：

- Discord 插件操作运行时文件
- Slack 插件操作运行时文件
- Telegram 插件操作运行时文件
- WhatsApp 插件操作运行时文件

## 核心集成流程

### 1. 运行嵌入式代理

主入口点是 `pi-embedded-runner/run.ts` 中的 `runEmbeddedPiAgent()`：

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
  model: "claude-sonnet-4-6",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 2. 会话创建

在 `runEmbeddedAttempt()`（由 `runEmbeddedPiAgent()` 调用）内部，使用 pi SDK：

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

### 3. 事件订阅

`subscribeEmbeddedPiSession()` 订阅 pi 的 `AgentSession` 事件：

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

处理的事件包括：

- `message_start` / `message_end` / `message_update`（流式文本/思考）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 提示

设置后，提示会话：

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK 处理完整的代理循环：发送到 LLM、执行工具调用、流式响应。

图像注入是提示本地的：OpenClaw 从当前提示加载图像引用，并仅通过 `images` 传递它们用于该轮次。它不会重新扫描旧的历史轮次来重新注入图像负载。

## 工具架构

### 工具管道

1. **基础工具**：pi 的 `codingTools`（读取、bash、编辑、写入）
2. **自定义替换**：OpenClaw 用 `exec`/`process` 替换 bash，为沙箱自定义读取/编辑/写入
3. **OpenClaw 工具**：消息、浏览器、画布、会话、cron、网关等
4. **渠道工具**：Discord/Telegram/Slack/WhatsApp 特定的操作工具
5. **策略过滤**：通过配置文件、提供程序、代理、组、沙箱策略过滤工具
6. **模式规范化**：为 Gemini/OpenAI 怪癖清理模式
7. **AbortSignal 包装**：包装工具以尊重中止信号

### 工具定义适配器

pi-agent-core 的 `AgentTool` 具有与 pi-coding-agent 的 `ToolDefinition` 不同的 `execute` 签名。`pi-tool-definition-adapter.ts` 中的适配器架起桥梁：

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent 签名与 pi-agent-core 不同
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### 工具拆分策略

`splitSdkTools()` 通过 `customTools` 传递所有工具：

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // 空。我们覆盖所有内容
    customTools: toToolDefinitions(options.tools),
  };
}
```

这确保 OpenClaw 的策略过滤、沙箱集成和扩展工具集在提供程序之间保持一致。

## 系统提示构造

系统提示在 `buildAgentSystemPrompt()`（`system-prompt.ts`）中构建。它组装包含部分的完整提示，包括工具、工具调用样式、安全防护栏、OpenClaw CLI 参考、技能、文档、工作区、沙箱、消息、回复标签、语音、静默回复、心跳、运行时元数据，加上启用时的内存和反应，以及可选的上下文文件和额外系统提示内容。为子代理使用的最小提示模式修剪部分。

提示在会话创建后通过 `applySystemPromptOverrideToSession()` 应用：

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## 会话管理

### 会话文件

会话是具有树结构的 JSONL 文件（id/parentId 链接）。Pi 的 `SessionManager` 处理持久化：

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw 用 `guardSessionManager()` 包装此以实现工具结果安全。

### 会话缓存

`session-manager-cache.ts` 缓存 SessionManager 实例以避免重复的文件解析：

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 历史限制

`limitHistoryTurns()` 根据渠道类型（DM 与群组）修剪对话历史。

### 压缩

上下文溢出时触发自动压缩。常见的溢出签名包括 `request_too_large`、`context length exceeded`、`input exceeds the maximum number of tokens`、`input token count exceeds the maximum number of input tokens`、`input is too long for the model` 和 `ollama error: context length exceeded`。`compactEmbeddedPiSessionDirect()` 处理手动压缩：

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 身份验证与模型解析

### 身份验证配置文件

OpenClaw 维护身份验证配置文件存储，每个提供程序有多个 API 密钥：

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

配置文件在故障时轮换，带有冷却跟踪：

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

// 使用 pi 的 ModelRegistry 和 AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### 故障转移

配置后，`FailoverError` 触发模型回退：

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

## Pi 扩展

OpenClaw 加载自定义 pi 扩展以实现专门的行为：

### 压缩防护

`src/agents/pi-hooks/compaction-safeguard.ts` 向压缩添加防护栏，包括自适应令牌预算以及工具故障和文件操作摘要：

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### 上下文压缩

`src/agents/pi-hooks/context-pruning.ts` 实现基于缓存 TTL 的上下文压缩：

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

## 流式与块回复

### 块分块

`EmbeddedBlockChunker` 管理将流式文本分块为离散的回复块：

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 思考/最终标签剥离

处理流式输出以剥离 `<think>`/`<thinking>` 块并提取 `<final>` 内容：

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // 剥离 <think>...</think> 内容
  // 如果 enforceFinalTag，仅返回 <final>...</final> 内容
};
```

### 回复指令

解析并提取回复指令，如 `[[media:url]]`、`[[voice]]`、`[[reply:id]]`：

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## 错误处理

### 错误分类

`pi-embedded-helpers.ts` 对错误进行分类以进行适当处理：

```typescript
isContextOverflowError(errorText)     // 上下文太大
isCompactionFailureError(errorText)   // 压缩失败
isAuthAssistantError(lastAssistant)   // 身份验证失败
isRateLimitAssistantError(...)        // 速率限制
isFailoverAssistantError(...)         // 应故障转移
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 思考级别回退

如果思考级别不受支持，则回退：

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

## 沙箱集成

启用沙箱模式后，工具和路径受到约束：

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // 使用沙箱读取/编辑/写入工具
  // Exec 在容器中运行
  // 浏览器使用桥接 URL
}
```

## 提供程序特定处理

### Anthropic

- 拒绝魔术字符串清理
- 连续角色的轮次验证
- 严格的上游 Pi 工具参数验证

### Google/Gemini

- 插件拥有的工具模式清理

### OpenAI

- 用于 Codex 模型的 `apply_patch` 工具
- 思考级别降级处理

## TUI 集成

OpenClaw 还具有直接使用 pi-tui 组件的本地 TUI 模式：

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

这提供类似于 pi 本机模式的交互式终端体验。

## 与 Pi CLI 的主要区别

| 方面     | Pi CLI                  | OpenClaw Embedded                                                                               |
| -------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| 调用     | `pi` 命令 / RPC         | 通过 `createAgentSession()` 的 SDK                                                              |
| 工具     | 默认编码工具            | 自定义 OpenClaw 工具套件                                                                        |
| 系统提示 | AGENTS.md + 提示        | 每个渠道/上下文的动态                                                                           |
| 会话存储 | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/`（或 `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`） |
| 身份验证 | 单个凭据                | 具有轮换的多配置文件                                                                            |
| 扩展     | 从磁盘加载              | 程序化 + 磁盘路径                                                                               |
| 事件处理 | TUI 渲染                | 基于回调的（onBlockReply 等）                                                                   |

## 未来考虑

潜在返工领域：

1. **工具签名对齐**：当前在 pi-agent-core 和 pi-coding-agent 签名之间进行适配
2. **会话管理器包装**：`guardSessionManager` 添加了安全性，但增加了复杂性
3. **扩展加载**：可以更直接地使用 pi 的 `ResourceLoader`
4. **流式处理程序复杂性**：`subscribeEmbeddedPiSession` 变得很大
5. **提供程序怪癖**：pi 可能潜在处理的许多提供程序特定代码路径

## 测试

Pi 集成覆盖范围跨越这些套件：

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
- `src/agents/pi-hooks/**/*.test.ts`

实时/选择加入：

- `src/agents/pi-embedded-runner-extraparams.live.test.ts`（启用 `OPENCLAW_LIVE_TEST=1`）

有关当前运行命令，请参阅 [Pi 开发工作流](/pi-dev)。
