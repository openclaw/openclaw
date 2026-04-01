# OpenClaw 上下文压缩系统 — 消息流分析

## 一、消息流全景

```
用户消息
  ↓
agent-runner.ts (runReplyAgent)
  ↓
agent-runner-memory.ts (runPreflightCompactionIfNeeded)
  ↓ 检查 token 阈值
  ↓
pi-embedded-runner (run/attempt.ts)
  ↓ 调用 pi-coding-agent 的 createAgentSession
  ↓
pi-agent-core (外部库 - Mario Zechner)
  │
  ├─ SessionManager 管理消息历史
  ├─ AgentMessage[] 消息数组
  ├─ streamSimple() 流式调用模型
  ├─ 自动检测 context overflow
  └─ 触发 auto_compaction 事件
       │
       ├─ handleAutoCompactionStart (pi-embedded-subscribe.handlers.compaction.ts)
       │   └─ 运行 before_compaction plugin hook
       │
       ├─ compaction.ts (summarizeChunks)
       │   ├─ stripToolResultDetails — 安全处理
       │   ├─ chunkMessagesByMaxTokens — 分片
       │   ├─ generateSummary — 调模型生成摘要
       │   └─ retryAsync — 重试机制
       │
       └─ handleAutoCompactionEnd
           ├─ incrementCompactionCount
           ├─ 运行 after_compaction hook
           └─ 重试 LLM 请求
```

## 二、关键文件清单

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/auto-reply/reply/agent-runner.ts` | Agent 回复主入口 | 800+ |
| `src/auto-reply/reply/agent-runner-memory.ts` | 内存/压缩前置检查 | ~200 |
| `src/auto-reply/reply/memory-flush.ts` | 压缩阈值判断 | ~150 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Agent 执行核心 | 800+ |
| `src/agents/compaction.ts` | 摘要生成（核心压缩逻辑） | 529 |
| `src/agents/context-window-guard.ts` | 上下文窗口监控 | ~80 |
| `src/agents/context.ts` | token 计算和模型上下文推断 | ~460 |
| `src/agents/compaction-hooks.ts` | 压缩钩子 | ~100 |
| `src/agents/pi-embedded-subscribe.handlers.compaction.ts` | 压缩事件处理 | ~100 |
| `src/agents/compaction-safeguard.ts` | 压缩安全检查 | ~200 |

## 三、已有的压缩能力

### compaction.ts 实现了什么

1. **token 估算** — `estimateMessagesTokens()` 基于 chars/4 启发式
2. **消息分片** — `splitMessagesByTokenShare()` / `chunkMessagesByMaxTokens()`
3. **自适应 chunk 比例** — `computeAdaptiveChunkRatio()` 大消息用更小 chunk
4. **分片摘要** — `summarizeChunks()` 逐 chunk 调模型生成摘要
5. **摘要合并** — `MERGE_SUMMARIES_INSTRUCTIONS` 合并多个部分摘要
6. **渐进降级** — `summarizeWithFallback()` 全量失败→排除大消息→兜底
7. **安全处理** — `stripToolResultDetails()` 不把工具详情喂给摘要模型
8. **标识符保留** — `IDENTIFIER_PRESERVATION_INSTRUCTIONS` 保留 UUID/hash/URL
9. **重试机制** — `retryAsync()` 3次重试 + 指数退避

### 缺失的压缩层（对比 Claude Code）

| 层 | Claude Code | OpenClaw 现状 | 难度 |
|---|------------|-------------|------|
| **ToolResultBudget** | 截断单个工具结果 | ❌ 无 | 🟢 低 |
| **snipCompact** | 丢弃历史尾巴 | ❌ 无 | 🟢 低 |
| **microCompact** | 删除冗余结果 | ❌ 无 | 🟡 中 |
| **autoCompact** | 模型生成摘要 | ✅ 已有 | — |
| **contextCollapse** | 折叠旧上下文 | ❌ 无 | 🔴 高 |

## 四、消息类型系统

OpenClaw 使用 `@mariozechner/pi-agent-core` 的 `AgentMessage` 类型：

```typescript
type AgentMessage = {
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentBlock[]
  timestamp?: number
  // ...其他字段
}

type ContentBlock =
  | { type: "text", text: string }
  | { type: "tool_use", id: string, name: string, input: object }
  | { type: "tool_result", tool_use_id: string, content: string, is_error?: boolean }
  | { type: "image", ... }
```

**关键区别**：OpenClaw 的 AgentMessage 比 Claude Code 的 Message 类型简单得多，没有 CompactBoundaryMessage、TombstoneMessage 等复杂类型。

## 五、新压缩层的插入点

### Layer 1: ToolResultBudget（最容易）

**插入点**：`src/agents/session-transcript-repair.ts` 的 `stripToolResultDetails()`

**原理**：在工具结果被加入消息历史时，截断超过阈值的输出。

```typescript
// 现有代码已有 stripToolResultDetails() 做安全处理
// 在此基础上加大小截断即可
const MAX_TOOL_RESULT_CHARS = 50000; // 约 12K tokens
if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
  resultContent = resultContent.slice(0, MAX_TOOL_RESULT_CHARS) 
    + `\n\n[... truncated, ${resultContent.length - MAX_TOOL_RESULT_CHARS} chars omitted]`;
}
```

**需要修改的文件**：
- `src/agents/session-transcript-repair.ts` — 加截断逻辑

### Layer 2: snipCompact（简单）

**插入点**：`src/agents/pi-embedded-subscribe.handlers.compaction.ts` 的 `handleAutoCompactionStart`

**原理**：在 autoCompact 之前，先丢弃最旧的 N% 消息（保留系统消息和最近消息）。

```typescript
// 在 compaction 开始前，先截断
const KEEP_RECENT_RATIO = 0.6; // 保留最近 60%
const messages = session.messages;
const cutoff = Math.floor(messages.length * (1 - KEEP_RECENT_RATIO));
const oldMessages = messages.slice(0, cutoff);
const recentMessages = messages.slice(cutoff);
// 用 oldMessages 生成摘要，然后 [摘要 + ...recentMessages]
```

**需要修改的文件**：
- `src/agents/compaction.ts` — 新增 `snipCompact()` 函数
- `src/agents/pi-embedded-subscribe.handlers.compaction.ts` — 在 autoCompact 前调用

### Layer 3: microCompact（中等）

**插入点**：`src/agents/pi-embedded-runner/run/attempt.ts` 的消息组装阶段

**原理**：检测重复的工具结果（同一文件读了 3 次），只保留最后一次。

```typescript
// 扫描消息，记录 tool_result 的 tool_use_id 和内容 hash
// 如果同一个 tool 多次调用且输入相同，只保留最后一次结果
const seen = new Map<string, number>(); // key -> last index
for (let i = 0; i < messages.length; i++) {
  if (isToolResult(messages[i])) {
    const key = `${toolName}:${hash(input)}`;
    if (seen.has(key)) {
      // 标记旧的为可删除
      markForRemoval(seen.get(key)!);
    }
    seen.set(key, i);
  }
}
```

**需要修改的文件**：
- `src/agents/compaction.ts` — 新增 `microCompact()` 函数
- `src/agents/pi-embedded-runner/run/attempt.ts` — 在消息发送前调用

## 六、实施计划

| 阶段 | 任务 | 文件 | 预计时间 |
|------|------|------|---------|
| 1 | ToolResultBudget | session-transcript-repair.ts | 1h |
| 2 | snipCompact | compaction.ts + handlers | 2h |
| 3 | microCompact | compaction.ts + attempt.ts | 3h |
| 4 | 单元测试 | *.test.ts | 2h |
| 5 | 集成测试 | 端到端测试 | 2h |
| 6 | PR 描述 | README + RFC | 1h |

**总计：约 11 小时开发**
