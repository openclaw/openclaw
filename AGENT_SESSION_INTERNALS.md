# Agent Session 内部机制文档

> 面向开发者，基于 `src/agents/pi-embedded-runner/run/attempt.ts` 及相关源文件，详细记录 `createAgentSession` 的完整实现机制，包含 session 加载、上下文压缩、工具构建、RAG 检索、system prompt 构建等核心流程。

---

## 目录

1. [整体流程图](#一整体流程图)
2. [Session 加载与恢复](#二session-加载与恢复)
3. [Context 超长时的多级压缩策略](#三context-超长时的多级压缩策略)
4. [工具（Tools）构建流程](#四工具tools构建流程)
5. [RAG / Memory 检索机制](#五rag--memory-检索机制)
6. [System Prompt 构建与覆盖](#六system-prompt-构建与覆盖)
7. [StreamFn 多层包装](#七streamfn-多层包装)

---

## 一、整体流程图

```
params.sessionFile
    │
    ▼
① repairSessionFileIfNeeded()      ← 清理崩溃产生的损坏 JSONL 行
    │
    ▼
② SessionManager.open(sessionFile)  ← 同步读取 JSONL → 消息历史
    │
    ▼
③ prepareSessionManagerForRun()     ← 写入 session 头、初始化结构
    │
    ▼
④ buildEmbeddedExtensionFactories() ← 决定 compaction/pruning 扩展策略
    │
    ▼
⑤ createOpenClawCodingTools()       ← 构建完整工具集
    │ splitSdkTools()
    ├── builtInTools (pi 内置: read/write/bash...)
    └── customTools  (OpenClaw: message/memory/web...)
    │
    ▼
⑥ createAgentSession({              ← 核心：创建 Agent + 注入历史消息
     sessionManager, model,
     tools, customTools, resourceLoader
   })
    │
    ▼
⑦ applySystemPromptOverrideToSession() ← 完全覆盖 pi 默认 system prompt
    │
    ▼
⑧ installToolResultContextGuard()  ← 安装 transformContext hook（实际截断在每次 LLM 请求前触发）
    │
    ▼
⑧.5 StreamFn 多层包装（attempt.ts:1267-1423）
    ├── wrapOllamaCompatNumCtx / cacheTrace / dropThinkingBlocks
    ├── sanitizeToolCallIds / downgradeReasoningPairs / trimToolCallNames
    └── wrapStreamFnDecodeXaiToolCallArguments / anthropicPayloadLogger
    │
    ▼
⑨ 历史消息后处理管道:
    ├── sanitizeSessionHistory()    ← 修复 tool_use/tool_result 配对
    ├── validateGeminiTurns() / validateAnthropicTurns()
    ├── limitHistoryTurns()         ← 按 historyLimit 截断轮数
    ├── sanitizeToolUseResultPairing() ← 截断后再次修复孤儿配对
    └── contextEngine.assemble()   ← 可选：调用方注入的外部 SPI（可替换消息列表或追加 system prompt）
    │
    ▼
⑩ subscribeEmbeddedPiSession()     ← 事件总线桥接（流式输出、工具调用）
    │
    ▼
⑪ activeSession.prompt(message)    ← 开始推理
```

---

## 二、Session 加载与恢复

### 2.1 加载前：修复损坏的 JSONL

**文件**：`src/agents/session-file-repair.ts`

Session 存储在磁盘上的 JSONL 文件里。如果上次进程异常退出，最后一行可能是截断的 JSON，导致 `SessionManager` 初始化失败。`repairSessionFileIfNeeded` 在加载前做防御性修复：

```19:109:src/agents/session-file-repair.ts
export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  // 1. 读取文件，逐行 JSON.parse，跳过解析失败的行
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
      droppedLines += 1;   // 记录损坏行数但不抛错
    }
  }

  // 2. 有损坏行时：先备份原文件 → 原子性写入修复版（tmp → rename）
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  await fs.writeFile(backupPath, content);          // 备份
  await fs.writeFile(tmpPath, cleaned);             // 写临时文件
  await fs.rename(tmpPath, sessionFile);            // 原子替换
}
```

### 2.2 Session 文件格式（JSONL）

每行一个 JSON 对象，主要类型：

| `type` 字段               | 含义                                      |
| ------------------------- | ----------------------------------------- |
| `"session"`               | 文件头（id、version、timestamp、cwd）     |
| `"message"`               | 对话消息（role: user/assistant，content） |
| `"model_change"`          | 模型切换记录                              |
| `"thinking_level_change"` | 思考级别变化                              |
| `"compaction"`            | pi 内部做了 compaction 的摘要标记         |

示例：

```jsonl
{"type":"session","id":"abc123","version":1,"cwd":"/workspace"}
{"type":"message","role":"user","content":"帮我重构这个函数"}
{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read",...}]}
{"type":"message","role":"tool","tool_use_id":"t1","content":"文件内容..."}
```

### 2.3 SessionManager 初始化

**文件**：`attempt.ts`，第 1124 行

```1124:1130:src/agents/pi-embedded-runner/run/attempt.ts
sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
  agentId: sessionAgentId,
  sessionKey: params.sessionKey,
  inputProvenance: params.inputProvenance,
  allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
  allowedToolNames,
});
```

`SessionManager.open()` 同步读取 JSONL → 建立 entry Map → 从 root 遍历到 leaf 重建有序消息列表。

`guardSessionManager`（`src/agents/session-tool-result-guard-wrapper.ts`）是对 SessionManager 的包装器，在写入新消息时校验 `tool_use` / `tool_result` 配对合法性，防止写入孤儿 tool result。

### 2.4 消息注入 Agent

`createAgentSession` 内部拿到 `sessionManager`，调用 `buildSessionContext()` 取出历史消息后执行：

```typescript
// pi-coding-agent 内部 sdk.js
agent.replaceMessages(existingSession.messages);
```

此时历史对话已全部加载到 Agent 的内存上下文中。

---

## 三、Context 超长时的多级压缩策略

当 session 消息历史积累过长时，有四层防护依次生效：

### 第一层：History Turns 限制（时间最早，按轮数截断）

**文件**：`src/agents/pi-embedded-runner/history.ts`，第 15 行

```15:36:src/agents/pi-embedded-runner/history.ts
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  // 从后往前遍历，数 user 消息轮数
  // 超过 limit 轮时，返回 messages.slice(lastUserIndex)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);  // 截掉更早的轮次
      }
      lastUserIndex = i;
    }
  }
  return messages;
}
```

**触发条件**：按 sessionKey 解析 provider，查找 `config.channels.<provider>.dmHistoryLimit`（DM 会话）或 `historyLimit`（群组/频道会话）。

**调用位置**（attempt.ts 第 1444 行）：

```1444:1453:src/agents/pi-embedded-runner/run/attempt.ts
const truncated = limitHistoryTurns(
  validated,
  getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
  // getDmHistoryLimitFromSessionKey 是 getHistoryLimitFromSessionKey 的弃用别名
);
// 截断后再次修复可能产生的孤儿 tool_use/tool_result 配对
const limited = transcriptPolicy.repairToolUseResultPairing
  ? sanitizeToolUseResultPairing(truncated)
  : truncated;
```

### 第二层：Tool Result 逐条截断（`installToolResultContextGuard`）

**文件**：`src/agents/pi-embedded-runner/tool-result-context-guard.ts`，第 184 行

这是最核心的实时压缩机制，通过 hook `agent.transformContext`，在**每次向 LLM 发送请求前**动态执行：

```184:223:src/agents/pi-embedded-runner/tool-result-context-guard.ts
export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
}): () => void {
  // 参数计算：
  // contextBudgetChars = contextWindowTokens × 4字符/token × 0.75（保留 25% 余量）
  // maxSingleToolResultChars = contextWindowTokens × chars_per_token × 0.5（单条上限）
  const contextBudgetChars = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO
  );
  const maxSingleToolResultChars = Math.floor(
    contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE
  );

  mutableAgent.transformContext = async (messages, signal) => {
    // 先执行原有的 transformContext（如果存在），保持 hook 链式调用
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    enforceToolResultContextBudgetInPlace({
      messages: transformed,
      contextBudgetChars,
      maxSingleToolResultChars,
    });
    return transformed;  // 就地修改，返回同一数组
  };
}
```

**`enforceToolResultContextBudgetInPlace` 的两步处理**（第 154 行）：

**步骤一：逐条截断超长 tool result**

```154:182:src/agents/pi-embedded-runner/tool-result-context-guard.ts
// 每个 tool result 单独截断到 maxSingleToolResultChars
for (const message of messages) {
  if (!isToolResultMessage(message)) continue;
  const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
  applyMessageMutationInPlace(message, truncated, estimateCache);
}
// 截断标记：末尾追加 "\n[truncated: output exceeded context limit]"
```

**步骤二：整体超出预算时，从最旧的 tool result 开始压缩**

```94:130:src/agents/pi-embedded-runner/tool-result-context-guard.ts
function compactExistingToolResultsInPlace(params) {
  // 从最旧的 tool result 开始，逐条替换为占位符
  // 直到总 chars 降到 contextBudgetChars 以下为止
  for (let i = 0; i < messages.length; i++) {
    if (!isToolResultMessage(messages[i])) continue;
    const compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    // 占位符内容：[compacted: tool output removed to free context]
    reduced += before - after;
    if (reduced >= charsNeeded) break;  // 够了就停
  }
}
```

### 第三层：Extension 级别的 Compaction（pi-coding-agent 内置）

**文件**：`src/agents/pi-embedded-runner/extensions.ts`（`buildEmbeddedExtensionFactories`）

这是 pi-coding-agent 框架级别的压缩策略，通过 `DefaultResourceLoader` 注册扩展插件：

- **`compactionSafeguardExtension`**：当 context 占 session 历史的比例超过 `maxHistoryShare` 时触发压缩，可配置 `qualityGuard`（保证输出质量的阈值）
- **`contextPruningExtension`**：按缓存 TTL 策略裁剪历史，适合缓存友好的 provider（如 Claude）

```1157:1182:src/agents/pi-embedded-runner/run/attempt.ts
const extensionFactories = buildEmbeddedExtensionFactories({
  cfg: params.config,
  sessionManager,
  provider: params.provider,
  modelId: params.modelId,
  model: params.model,
});
if (extensionFactories.length > 0) {
  resourceLoader = new DefaultResourceLoader({
    cwd: resolvedWorkspace,
    agentDir,
    settingsManager,
    extensionFactories,  // 注册到 pi 框架
  });
  await resourceLoader.reload();
}
```

### 第四层：外部 Context Engine（可选）

**位置**：attempt.ts 第 1459 行

`contextEngine` 是由调用方（`run.ts`）通过参数注入的可选 SPI 接口，不是框架内置功能。当参数中携带 `contextEngine` 时，在所有内部处理之后调用其 `assemble()` 方法，可以完全替换消息列表或追加 system prompt。调用被 `try/catch` 包裹——`assemble` 失败时记录 warn 后继续，不中断流程：

```1459:1484:src/agents/pi-embedded-runner/run/attempt.ts
if (params.contextEngine) {
  try {
    const assembled = await params.contextEngine.assemble({
      sessionId: params.sessionId,
      messages: activeSession.messages,
      tokenBudget: params.contextTokenBudget,
    });
    if (assembled.messages !== activeSession.messages) {
      activeSession.agent.replaceMessages(assembled.messages);  // 替换为 context engine 的结果
    }
    if (assembled.systemPromptAddition) {
      systemPromptText = prependSystemPromptAddition({
        systemPrompt: systemPromptText,
        systemPromptAddition: assembled.systemPromptAddition,  // 追加 system prompt
      });
      applySystemPromptOverrideToSession(activeSession, systemPromptText);
    }
  } catch (assembleErr) {
    log.warn(`context engine assemble failed: ${String(assembleErr)}`);
    // 失败后继续，不中断流程
  }
}
```

### 各层压缩总结

| 层级                    | 实现位置                       | 触发时机               | 压缩粒度              | 标记                                |
| ----------------------- | ------------------------------ | ---------------------- | --------------------- | ----------------------------------- |
| 1. History Turns        | `history.ts`                   | session 加载后、推理前 | 整轮对话              | 直接删除                            |
| 2. Tool Result Guard    | `tool-result-context-guard.ts` | 每次请求前（hook）     | 单条/整体 tool result | `[truncated...]` / `[compacted...]` |
| 3. Extension Compaction | `extensions.ts` + pi 内核      | 框架感知到超长时       | 历史段落              | 由 pi 内核决定                      |
| 4. Context Engine       | `attempt.ts`                   | 加载后可选             | 完全自定义            | 由外部决定                          |

---

## 四、工具（Tools）构建流程

### 4.1 工具创建（attempt.ts 第 869 行）

```869:916:src/agents/pi-embedded-runner/run/attempt.ts
const toolsRaw = params.disableTools
  ? []
  : createOpenClawCodingTools({
      agentId: sessionAgentId,
      exec: { ...params.execOverrides, elevated: params.bashElevated },
      sandbox,
      messageProvider: params.messageChannel ?? params.messageProvider,
      sessionKey, sessionId, runId, agentDir, workspaceDir,
      config: params.config,
      abortSignal: runAbortController.signal,
      modelProvider: params.model.provider,
      modelHasVision,
      ...
    });
// 不支持工具的模型（如部分 Gemini 配置）直接清空
const tools = sanitizeToolsForGoogle({
  tools: toolsEnabled ? toolsRaw : [],
  provider: params.provider,
});
```

**`createOpenClawCodingTools`**（`src/agents/pi-tools.ts`）的构建逻辑：

1. **基础文件工具**（pi-coding-agent 内置）：`read`、`write`、`edit`、`grep`、`find`、`ls` — 在 sandbox 模式下替换为 sandbox 变体
2. **执行工具**：`exec`（bash）、`process`（后台进程）、`apply_patch`（OpenAI 专用）
3. **OpenClaw 专属工具**（`createOpenClawTools`）：`message`、`memory_search`、`memory_get`、`web_search`、`web_fetch`、`image`、`browser`、`canvas`、`tts`、`cron`、`nodes`、`sessions_*`、`subagents` 等
4. **策略过滤**：`resolveEffectiveToolPolicy` → owner-only 过滤 → allowlist/denylist pipeline
5. **Schema 规范化**：修复 Google/Anthropic/Mistral 不兼容的 schema 格式

### 4.2 工具分层传递给 Session

```1187:1214:src/agents/pi-embedded-runner/run/attempt.ts
const { builtInTools, customTools } = splitSdkTools({
  tools,
  sandboxEnabled: !!sandbox?.enabled,
});

// 添加 client tools（OpenResponses 托管工具）
const clientToolDefs = clientTools
  ? toClientToolDefinitions(clientTools, onToolCallDetected, { ... })
  : [];

const allCustomTools = [...customTools, ...clientToolDefs];

({ session } = await createAgentSession({
  tools: builtInTools,          // pi 内置工具（pi 框架直接识别和执行）
  customTools: allCustomTools,  // OpenClaw 自定义工具（通过 pi 的 customTools 机制执行）
  ...
}));
```

`splitSdkTools`（`src/agents/tool-split.ts`）按工具名是否属于 pi 内置集合来分类：

- `builtInTools`：pi-coding-agent 原生支持的工具（read/write/edit/bash/grep 等），pi 框架对这些有特殊处理（如 bash 工具有内置沙箱逻辑）
- `customTools`：所有其他工具，通过 pi 的 customTools 接口注册

---

## 五、RAG / Memory 检索机制

### 5.1 memory_search 工具定义

**文件**：`src/agents/tools/memory-tool.ts`

```typescript
{
  name: "memory_search",
  description: "Mandatory recall step: semantically search MEMORY.md + memory/*.md " +
    "(and optional session transcripts) before answering questions about prior work, " +
    "decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
  execute: async (_toolCallId, params) => {
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    return manager.search(query, { maxResults, minScore, sessionKey });
  }
}
```

工具描述中包含 **"Mandatory recall step"** 的强制语言，指导 LLM 在回答涉及历史信息的问题前必须先调用此工具。

### 5.2 Memory 检索的后端实现

`memory_search` 工具内部调用的 `manager.search()` 使用向量相似度检索：

1. **索引范围**：`MEMORY.md` + `memory/*.md`（以及可选的 session transcript）
2. **向量化**：文件被分块后用 embedding 模型（如 `text-embedding-3-small`）向量化，存入本地 SQLite
3. **检索**：query 向量化后，余弦相似度检索，返回 top-N 片段（含 path、startLine、endLine、citation）

### 5.3 System Prompt 中的 Memory 指令注入

**文件**：`src/agents/system-prompt.ts`（`buildAgentSystemPrompt`）

当工具列表中包含 `memory_search` 或 `memory_get` 时，system prompt 自动注入 `## Memory Recall` 段落，进一步强化"必须先检索"的约束：

```typescript
if (toolNames.includes("memory_search") || toolNames.includes("memory_get")) {
  sections.push(`## Memory Recall
Before answering questions about prior work, decisions, preferences, dates, or todos,
call memory_search first. Then use memory_get to retrieve specific sections if needed.`);
}
```

### 5.4 触发机制总结

OpenClaw 的 memory RAG **没有自动触发机制**，完全依赖 LLM 主动调用工具：

| 触发手段                                      | 位置               | 强度                     |
| --------------------------------------------- | ------------------ | ------------------------ |
| 工具 description 中的 "Mandatory recall step" | `memory-tool.ts`   | 强（每次工具可见时）     |
| System prompt 的 `## Memory Recall` 段落      | `system-prompt.ts` | 强（全局持续）           |
| `memory_get`（搜索后精准读取）                | `memory-tool.ts`   | 补充（配合 search 使用） |

### 5.5 subscribeEmbeddedPiSession 的作用

**文件**：`src/agents/pi-embedded-subscribe.ts`

这不是 RAG 触发器，而是**事件总线适配器**，将 pi-coding-agent 的 AgentSession 内部事件流桥接到 OpenClaw 的输出回调：

- 流式文本分块（`blockChunker`）
- reasoning/thinking 块处理
- tool result 格式化与转发（`onToolResult`）
- message 工具调用检测与去重
- compaction 重试状态管理（`waitForCompactionRetry`）
- token 用量统计（`usageTotals`）

---

## 六、System Prompt 构建与覆盖

### 6.1 构建流程（attempt.ts 第 1026 行附近）

System prompt 在 `createAgentSession` 调用**之前**构建完成：

```typescript
// attempt.ts
const appendPrompt = buildEmbeddedSystemPrompt({
  workspaceDir,
  defaultThinkLevel,
  reasoningLevel,
  extraSystemPrompt,        // 用户自定义追加
  ownerNumbers,             // owner 手机号（用于权限说明）
  heartbeatPrompt,          // 定时唤醒提示词
  skillsPrompt,             // 已加载的 skills 内容（30K chars 以内）
  docsPath,                 // 文档路径
  ttsHint,                  // TTS 提示
  workspaceNotes,           // 工作区备注
  sandboxInfo,              // sandbox 状态
  tools,                    // 工具列表（用于生成工具摘要）
  modelAliasLines,          // 模型别名说明
  userTimezone,             // 用户时区
  contextFiles,             // 上下文文件（bootstrap files）
  memoryCitationsMode,      // 记忆引用展示模式
  ...
});
```

**`buildEmbeddedSystemPrompt`**（`src/agents/pi-embedded-runner/system-prompt.ts` 第 11 行）是对 `buildAgentSystemPrompt`（`src/agents/system-prompt.ts`）的薄包装，额外从工具列表生成 `toolSummaries`：

```56:87:src/agents/pi-embedded-runner/system-prompt.ts
return buildAgentSystemPrompt({
  ...params,
  toolNames: params.tools.map((tool) => tool.name),
  toolSummaries: buildToolSummaryMap(params.tools),  // 工具摘要 Map（name → 一行描述）
});
```

### 6.2 覆盖 pi 默认 System Prompt

pi-coding-agent 内部有自己的 system prompt 生成逻辑，且会在工具变化时重新生成。OpenClaw 通过直接修改私有字段来**强制覆盖**，防止被 pi 内部重置：

```96:108:src/agents/pi-embedded-runner/system-prompt.ts
export function applySystemPromptOverrideToSession(
  session: AgentSession,
  override: string | ((defaultPrompt?: string) => string),
) {
  const prompt = typeof override === "function" ? override() : override.trim();
  session.agent.setSystemPrompt(prompt);        // 设置到 Agent（公开 API）

  // 直接 patch AgentSession 私有字段，拦截 pi 内部的 prompt 重建逻辑
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;  // 无论工具如何变化，始终返回 OpenClaw 的 prompt
}
```

调用位置（attempt.ts 第 1229 行）：

```1229:1229:src/agents/pi-embedded-runner/run/attempt.ts
applySystemPromptOverrideToSession(session, systemPromptText);
```

Context Engine 的 systemPromptAddition 追加也通过同一函数完成（attempt.ts 第 1474 行）。

---

## 七、StreamFn 多层包装

`activeSession.agent.streamFn` 是实际发出 LLM 请求的函数。OpenClaw 在此基础上叠加了多层 wrapper，每层处理一个关注点：

```
streamSimple / ollamaStreamFn / openAIWebSocketStreamFn  ← 基础传输层
    │ wrapOllamaCompatNumCtx()               ← Ollama: 注入 num_ctx（context window 大小）
    │ cacheTrace.wrapStreamFn()              ← 记录 prompt cache 命中情况（调试用）
    │ dropThinkingBlocks()                   ← Copilot/Claude: 剔除 thinking 块（不兼容 follow-up）
    │ sanitizeToolCallIdsForCloudCodeAssist()← Mistral/云代码: 修复 tool call ID 格式
    │ downgradeOpenAIFunctionCallReasoningPairs() ← OpenAI Responses API: 降级 function+reasoning 对
    │ wrapStreamFnTrimToolCallNames()         ← 去除工具名前后空格（某些模型输出 " read "）
    │ wrapStreamFnDecodeXaiToolCallArguments()← xAI Grok: 解码 tool 参数特殊编码
    └── anthropicPayloadLogger.wrapStreamFn()← 调试: 记录 Anthropic 原始 payload
```

`agent.transformContext` 这个 hook（由 `installToolResultContextGuard` 注入）在 `streamFn` 调用前执行，负责 context 压缩。

---

_最后更新：2026-03-09 | 基于 `src/agents/pi-embedded-runner/run/attempt.ts` @ openclaw main_
