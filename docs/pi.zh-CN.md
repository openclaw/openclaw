---
title: "Pi集成架构"
summary: "OpenClaw嵌入式Pi代理集成和会话生命周期的架构"
read_when:
  - 了解OpenClaw中的Pi SDK集成设计
  - 修改Pi的代理会话生命周期、工具或提供商连接
---

# Pi集成架构

本文档描述了OpenClaw如何与[pi-coding-agent](<https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)及其兄弟包（`pi-ai`、`pi-agent-core`、`pi-tui`）集成，以支持其AI代理功能。>

## 概述

OpenClaw使用pi SDK将AI编码代理嵌入到其消息网关架构中。OpenClaw不是将pi作为子进程生成或使用RPC模式，而是通过`createAgentSession()`直接导入并实例化pi的`AgentSession`。这种嵌入式方法提供：

- 对会话生命周期和事件处理的完全控制
- 自定义工具注入（消息传递、沙箱、通道特定操作）
- 按通道/上下文自定义系统提示
- 支持分支/压缩的会话持久性
- 具有故障转移的多账户认证配置文件轮换
- 提供商无关的模型切换

## 包依赖```json

{
"@mariozechner/pi-agent-core": "0.64.0",
"@mariozechner/pi-ai": "0.64.0",
"@mariozechner/pi-coding-agent": "0.64.0",
"@mariozechner/pi-tui": "0.64.0"
}```| 包 | 用途 |

|----------------- | ------------------------------------------------------------------------------------------------------|

|`pi-ai`| 核心LLM抽象：`Model`、`streamSimple`、消息类型、提供商API |

|`pi-agent-core`| 代理循环、工具执行、`AgentMessage`类型 |

|`pi-coding-agent`| 高级SDK：`createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、内置工具 |

|`pi-tui`| 终端UI组件（用于OpenClaw的本地TUI模式） |

## 文件结构```src/agents/

├── pi-embedded-runner.ts # 从pi-embedded-runner/重新导出
├── pi-embedded-runner/
│ ├── run.ts # 主入口：runEmbeddedPiAgent()
│ ├── run/
│ │ ├── attempt.ts # 带会话设置的单次尝试逻辑
│ │ ├── params.ts # RunEmbeddedPiAgentParams类型
│ │ ├── payloads.ts # 从运行结果构建响应有效载荷
│ │ ├── images.ts # 视觉模型图像注入
│ │ └── types.ts # EmbeddedRunAttemptResult
│ ├── abort.ts # 中止错误检测
│ ├── cache-ttl.ts # 用于上下文修剪的缓存TTL跟踪
│ ├── compact.ts # 手动/自动压缩逻辑
│ ├── extensions.ts # 为嵌入式运行加载pi扩展
│ ├── extra-params.ts # 提供商特定的流参数
│ ├── google.ts # Google/Gemini轮次排序修复
│ ├── history.ts # 历史限制（DM vs 群组）
│ ├── lanes.ts # 会话/全局命令通道
│ ├── logger.ts # 子系统记录器
│ ├── model.ts # 通过ModelRegistry解析模型
│ ├── runs.ts # 活动运行跟踪、中止、队列
│ ├── sandbox-info.ts # 系统提示的沙箱信息
│ ├── session-manager-cache.ts # SessionManager实例缓存
│ ├── session-manager-init.ts # 会话文件初始化
│ ├── system-prompt.ts # 系统提示构建器
│ ├── tool-split.ts # 将工具分为内置vs自定义
│ ├── types.ts # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│ └── utils.ts # ThinkLevel映射、错误描述
├── pi-embedded-subscribe.ts # 会话事件订阅/分发
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # 事件处理程序工厂
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts # 流式块回复分块
├── pi-embedded-messaging.ts # 消息工具发送跟踪
├── pi-embedded-helpers.ts # 错误分类、轮次验证
├── pi-embedded-helpers/ # 辅助模块
├── pi-embedded-utils.ts # 格式化实用程序
├── pi-tools.ts # createOpenClawCodingTools()
├── pi-tools.abort.ts # 工具的AbortSignal包装
├── pi-tools.policy.ts # 工具允许/拒绝列表策略
├── pi-tools.read.ts # 读取工具自定义
├── pi-tools.schema.ts # 工具架构标准化
├── pi-tools.types.ts # AnyAgentTool类型别名
├── pi-tool-definition-adapter.ts # AgentTool -> ToolDefinition适配器
├── pi-settings.ts # 设置覆盖
├── pi-hooks/ # 自定义pi钩子
│ ├── compaction-safeguard.ts # 保护扩展
│ ├── compaction-safeguard-runtime.ts
│ ├── context-pruning.ts # 缓存-TTL上下文修剪扩展
│ └── context-pruning/
├── model-auth.ts # 认证配置文件解析
├── auth-profiles.ts # 配置文件存储、冷却、故障转移
├── model-selection.ts # 默认模型解析
├── models-config.ts # models.json生成
├── model-catalog.ts # 模型目录缓存
├── context-window-guard.ts # 上下文窗口验证
├── failover-error.ts # FailoverError类
├── defaults.ts # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts # buildAgentSystemPrompt()
├── system-prompt-params.ts # 系统提示参数解析
├── system-prompt-report.ts # 调试报告生成
├── tool-summaries.ts # 工具描述摘要
├── tool-policy.ts # 工具策略解析
├── transcript-policy.ts # 转录验证策略
├── skills.ts # 技能快照/提示构建
├── skills/ # 技能子系统
├── sandbox.ts # 沙箱上下文解析
├── sandbox/ # 沙箱子系统
├── channel-tools.ts # 通道特定工具注入
├── openclaw-tools.ts # OpenClaw特定工具
├── bash-tools.ts # exec/process工具
├── apply-patch.ts # apply_patch工具（OpenAI）
├── tools/ # 单个工具实现
│ ├── browser-tool.ts
│ ├── canvas-tool.ts
│ ├── cron-tool.ts
│ ├── gateway-tool.ts
│ ├── image-tool.ts
│ ├── message-tool.ts
│ ├── nodes-tool.ts
│ ├── session*.ts
│ ├── web-*.ts
│ └ ...
└ ...```通道特定的消息操作运行时现在位于插件拥有的扩展目录中，而不是在`src/agents/tools`下，例如：

- Discord插件操作运行时文件
- Slack插件操作运行时文件
- Telegram插件操作运行时文件
- WhatsApp插件操作运行时文件

## 核心集成流程

### 1. 运行嵌入式代理

主入口点是`pi-embedded-runner/run.ts`中的`runEmbeddedPiAgent()`：```typescript
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
});```### 2. 会话创建

在`runEmbeddedAttempt()`（由`runEmbeddedPiAgent()`调用）内部，使用pi SDK：```typescript
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

applySystemPromptOverrideToSession(session, systemPromptOverride);``### 3. 事件订阅`subscribeEmbeddedPiSession()`订阅pi的`AgentSession`事件：``typescript
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
});```处理的事件包括：

-`message_start`/`message_end`/`message_update`（流式文本/思考）-`tool_execution_start`/`tool_execution_update`/`tool_execution_end`-`turn_start`/`turn_end`-`agent_start`/`agent_end`-`auto_compaction_start`/`auto_compaction_end`### 4. 提示

设置完成后，会话会被提示：`typescript
await session.prompt(effectivePrompt, { images: imageResult.images });`SDK处理完整的代理循环：发送到LLM、执行工具调用、流式响应。

图像注入是提示本地的：OpenClaw从当前提示加载图像引用，并仅在该轮通过`images`传递它们。它不会重新扫描旧的历史轮次来重新注入图像有效载荷。

## 工具架构

### 工具管道

1. **基础工具**：pi的`codingTools`（read、bash、edit、write）
2. **自定义替换**：OpenClaw用`exec`/`process`替换bash，为沙箱自定义read/edit/write
3. **OpenClaw工具**：消息传递、浏览器、画布、会话、cron、网关等
4. **通道工具**：Discord/Telegram/Slack/WhatsApp特定操作工具
5. **策略过滤**：按配置文件、提供商、代理、群组、沙箱策略过滤工具
6. **架构标准化**：清理架构以适应Gemini/OpenAI特性
7. **AbortSignal包装**：包装工具以尊重中止信号

### 工具定义适配器

pi-agent-core的`AgentTool`与pi-coding-agent的`ToolDefinition`具有不同的`execute`签名。`pi-tool-definition-adapter.ts`中的适配器桥接了这一点：`typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent签名与pi-agent-core不同
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}`### 工具拆分策略`splitSdkTools()`通过`customTools`传递所有工具：`typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // 空。我们覆盖所有内容
    customTools: toToolDefinitions(options.tools),
  };
}`这确保OpenClaw的策略过滤、沙箱集成和扩展工具集在提供商之间保持一致。

## 系统提示构建

系统提示在`buildAgentSystemPrompt()`（`system-prompt.ts`）中构建。它组装一个完整的提示，包括工具、工具调用风格、安全防护、OpenClaw CLI参考、技能、文档、工作区、沙箱、消息传递、回复标签、语音、静默回复、心跳、运行时元数据，以及启用时的内存和反应，以及可选的上下文文件和额外的系统提示内容。在子代理使用的最小提示模式下，这些部分会被修剪。

提示在会话创建后通过`applySystemPromptOverrideToSession()`应用：`typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);`## 会话管理

### 会话文件

会话是带有树结构（id/parentId链接）的JSONL文件。Pi的`SessionManager`处理持久性：`typescript
const sessionManager = SessionManager.open(params.sessionFile);`OpenClaw用`guardSessionManager()`包装此功能以确保工具结果安全。

### 会话缓存`session-manager-cache.ts`缓存SessionManager实例以避免重复文件解析：```typescript

await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);```### 历史限制`limitHistoryTurns()`根据通道类型（DM vs 群组）修剪对话历史。

### 压缩

自动压缩在上下文溢出时触发。常见的溢出签名包括`request_too_large`、`context length exceeded`、`input exceeds the maximum number of tokens`、`input token count exceeds the maximum number of input tokens`、`input is too long for the model`和`ollama error: context length exceeded`。`compactEmbeddedPiSessionDirect()`处理手动压缩：`typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});`## 认证和模型解析

### 认证配置文件

OpenClaw维护一个认证配置文件存储，每个提供商有多个API密钥：`typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });`配置文件在失败时旋转，带有冷却跟踪：`typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();`### 模型解析```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
provider,
modelId,
agentDir,
config,
);

// 使用pi的ModelRegistry和AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);``### 故障转移`FailoverError`在配置时触发模型回退：``typescript
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
throw new FailoverError(errorText, {
reason: promptFailoverReason ?? "unknown",
provider,
model: modelId,
profileId,
status: resolveFailoverStatus(promptFailoverReason),
});
}```## Pi扩展

OpenClaw加载自定义pi扩展以实现专门行为：

### 压缩保护`src/agents/pi-hooks/compaction-safeguard.ts`为压缩添加保护，包括自适应令牌预算以及工具失败和文件操作摘要：```typescript

if (resolveCompactionMode(params.cfg) === "safeguard") {
setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
paths.push(resolvePiExtensionPath("compaction-safeguard"));
}``### 上下文修剪`src/agents/pi-hooks/context-pruning.ts`实现基于缓存-TTL的上下文修剪：``typescript
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
setContextPruningRuntime(params.sessionManager, {
settings,
contextWindowTokens,
isToolPrunable,
lastCacheTouchAt,
});
paths.push(resolvePiExtensionPath("context-pruning"));
}```## 流式传输和块回复

### 块分块`EmbeddedBlockChunker`管理将流式文本转换为离散回复块：```typescript

const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;```### 思考/最终标签剥离

流式输出经过处理，剥离`<think>`/`<thinking>`块并提取`<final>`内容：`typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // 剥离 <think>...</think> 内容
  // 如果 enforceFinalTag，只返回 <final>...</final> 内容
};`### 回复指令

解析并提取`[[media:url]]`、`[[voice]]`、`[[reply:id]]`等回复指令：`typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);`## 错误处理

### 错误分类`pi-embedded-helpers.ts`对错误进行分类以进行适当处理：```typescript

isContextOverflowError(errorText) // 上下文太大
isCompactionFailureError(errorText) // 压缩失败
isAuthAssistantError(lastAssistant) // 认证失败
isRateLimitAssistantError(...) // 速率限制
isFailoverAssistantError(...) // 应该故障转移
classifyFailoverReason(errorText) // "auth" | "rate_limit" | "quota" | "timeout" | ...```### 思考级别回退

如果思考级别不受支持，它会回退：`typescript
const fallbackThinking = pickFallbackThinkingLevel({
  message: errorText,
  attempted: attemptedThinking,
});
if (fallbackThinking) {
  thinkLevel = fallbackThinking;
  continue;
}`## 沙箱集成

当启用沙箱模式时，工具和路径受到限制：```typescript
const sandbox = await resolveSandboxContext({
config: params.config,
sessionKey: sandboxSessionKey,
workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
// 使用沙箱化的read/edit/write工具
// Exec在容器中运行
// 浏览器使用桥接URL
}```## 提供商特定处理

### Anthropic

- 拒绝魔术字符串清理
- 连续角色的轮次验证
- 严格的上游Pi工具参数验证

### Google/Gemini

- 插件拥有的工具架构清理

### OpenAI

- 用于Codex模型的`apply_patch`工具
- 思考级别降级处理

## TUI集成

OpenClaw还具有直接使用pi-tui组件的本地TUI模式：`typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";`这提供了类似于pi原生模式的交互式终端体验。

## 与Pi CLI的关键区别

| 方面 | Pi CLI | OpenClaw嵌入式 |

|--------------- | ----------------------- | ----------------------------------------------------------------------------------------------|

| 调用方式 |`pi`命令 / RPC | 通过`createAgentSession()`的SDK |

| 工具 | 默认编码工具 | 自定义OpenClaw工具套件 |

| 系统提示 | AGENTS.md + 提示 | 动态按通道/上下文 |

| 会话存储 |`~/.pi/agent/sessions/`|`~/.openclaw/agents/<agentId>/sessions/`（或`$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`） |

| 认证 | 单一凭证 | 带轮换的多配置文件 |

| 扩展 | 从磁盘加载 | 程序化 + 磁盘路径 |

| 事件处理 | TUI渲染 | 基于回调（onBlockReply等） |

## 未来考虑

可能需要重新设计的领域：

1. **工具签名对齐**：目前在pi-agent-core和pi-coding-agent签名之间进行适配
2. **会话管理器包装**：`guardSessionManager`增加了安全性但增加了复杂性
3. **扩展加载**：可以更直接地使用pi的`ResourceLoader`4. **流式处理程序复杂性**：`subscribeEmbeddedPiSession`已经变得很大
4. **提供商特性**：许多提供商特定的代码路径，pi可能可以处理

## 测试

Pi集成覆盖范围跨越这些套件：

-`src/agents/pi-*.test.ts`-`src/agents/pi-auth-json.test.ts`-`src/agents/pi-embedded-*.test.ts`-`src/agents/pi-embedded-helpers*.test.ts`-`src/agents/pi-embedded-runner*.test.ts`-`src/agents/pi-embedded-runner/**/*.test.ts`-`src/agents/pi-embedded-subscribe*.test.ts`-`src/agents/pi-tools*.test.ts`-`src/agents/pi-tool-definition-adapter*.test.ts`-`src/agents/pi-settings.test.ts`-`src/agents/pi-hooks/**/*.test.ts`实时/选择加入：

-`src/agents/pi-embedded-runner-extraparams.live.test.ts`（启用`OPENCLAW_LIVE_TEST=1`）

有关当前运行命令，请参阅[Pi开发工作流程](/pi-dev)。
