# Patch 07: 飞书回复调度器 -- 流式卡片、思考面板与指令标签剥离

## 为什么要改 (Why)

### 问题 1: 流式卡片缺少工具状态追踪和去重

飞书回复调度器（reply-dispatcher）在处理 agent 工具调用事件时，没有对 `toolCallId` 进行去重。同一个工具调用的 `start` 和 `update` 阶段会被重复注册到 `activeTools` 数组中，导致思考面板（thinking panel）显示错误的工具计数，且 `removeActiveTool` 无法正确匹配清理。

### 问题 2: 内联指令标签泄漏到用户可见的流式卡片

Agent 回复中可能包含内联指令标签（如 `[[reply_to_current]]`、`[[audio_as_voice]]`），这些标签在流式 partial 阶段被原样传递到飞书卡片中渲染，用户会看到类似 `[[reply_to:om_xxx]] 你好` 的原始标签文本。需要在渲染层和最终交付层分别进行剥离。

### 问题 3: `mergeStreamingText` 的子串去重逻辑破坏 Markdown 表格

旧版 `mergeStreamingText` 使用 `previous.includes(next)` 和 `previous.startsWith(next)` 检查来防止重复，但 delta 模式下的单字符 token（如 `|`、`\n`、`-`）天然是累积文本的子串。这导致 markdown 表格的分隔符行被静默吞掉，表格渲染完全错乱。

### 问题 4: 低级别 agent 事件（CLI runner followup）没有路由到飞书调度器

CLI provider 的 followup run 通过 `agent-runner-execution.ts` 执行时，工具调用事件（`onToolUseEvent`、`onToolResult`）、思考流（`onThinkingTurn`）、助手文本流（`onAssistantTurn`）没有被转发到飞书的 `onAgentEvent` 回调。followup 场景下飞书卡片不会显示任何思考或工具状态。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/reply-dispatcher.ts` | 新增 `seenToolCallIds` 去重集合；提取 `handleToolStartLikeEvent` / `handleToolResultLikeEvent` 统一处理工具事件；新增 `stripLeadingReplyDirectiveForRender` 渲染层剥离；在 `closeStreaming` 和 `deliver` 路径调用 `stripInlineDirectiveTagsForDelivery`；新增 `streamingActivityTimer` 保持流式阶段活跃度；`onAgentEvent` 回调监听低级别工具事件；`onReasoningStream` 增加 `stripInlineDirectiveTagsForDisplay` 清理 |
| `extensions/feishu/src/streaming-card.ts` | 移除 `sanitizeVisibleCardText` 函数（指令标签剥离上移到调度器层）；重写 `mergeStreamingText` 去掉子串/重叠检测，改为纯追加模式；调整 `streaming_config` 参数（`print_frequency_ms: 30`, `print_step: 50`）；`updateContent` / `updateThinking` / `close` 直接使用传入文本 |
| `extensions/feishu/src/send.ts` | 新增 `sanitizeFeishuTextForDelivery` 统一剥离函数；`enrichMentionPlaceholders` 替换 `@_user_N` 占位符；`buildStructuredCard` 支持 `thinkingTitle`/`thinkingText`/`thinkingExpanded` 参数构建可折叠思考面板；`buildMarkdownCard` / `buildStructuredCard` 统一经过 `normalizeMentionTagsForCard` 处理；`sendMessageFeishu` 在 `renderMode=card` 时直接走 `sendMarkdownCardFeishu`；`editMessageFeishu` 增加自动 card 模式检测 |
| `extensions/feishu/src/send.test.ts` | 移除了旧版 `stripInlineDirectiveTagsForDelivery` mock 和相关测试用例（逻辑已上移到 dispatcher 层） |
| `extensions/feishu/src/streaming-card.test.ts` | 新增 1009 行测试覆盖：`mergeStreamingText` delta 追加、markdown 表格保持、思考面板渲染、指令标签不在 card 层处理等 |
| `extensions/feishu/src/reply-dispatcher.test.ts` | 新增 256 行测试：工具去重、`streamPhase` 状态转换、`stripLeadingReplyDirectiveForRender` |
| `src/auto-reply/reply/agent-runner-execution.ts` | 新增 `onSystemInit`/`onAssistantTurn`/`onThinkingTurn`/`onToolUseEvent`/`onToolResult` 回调将 CLI followup 事件路由到 `onAgentEvent`；新增 `queueAssistantMessageStart` 确保 `signalMessageStart` 仅调用一次；在 pi-embedded agent 路径中转发 `onAgentEvent` |
| `src/auto-reply/types.ts` | `GetReplyOptions` 新增 `onAgentEvent` 回调类型声明 |

## 伪代码 (Pseudocode)

### 1. 工具调用去重与统一处理

```javascript
// reply-dispatcher.ts — 工具事件去重
const seenToolCallIds = new Set()

function noteToolCallSeen(payload, options) {
  const id = payload.toolCallId?.trim()
  if (!id) return options?.allowUnnamed === true
  if (seenToolCallIds.has(id)) return false  // 已见过，跳过
  seenToolCallIds.add(id)
  return true  // 新工具调用
}

// 统一处理工具启动事件（来自 onToolStart 或 onAgentEvent）
function handleToolStartLikeEvent(payload, options) {
  const isStart = !payload.phase || payload.phase === "start" || payload.phase === "update"
  if (isStart) {
    const isNew = noteToolCallSeen(payload, options)
    if (isNew) {
      activeTools.push({ name: payload.name, toolCallId: payload.toolCallId, startedAt: now })
      toolCallCount += 1
      // 启动工具耗时定时器（每10秒刷新面板）
      if (!toolElapsedTimer) {
        toolElapsedTimer = setInterval(() => queueThinkingPanelUpdate(), 10_000)
      }
    }
  }
  streamPhase = "tool"
  clearStreamingActivityTimer()  // 工具运行时不需要流式活跃度定时器
  startStreaming()               // 确保卡片已创建
  queueThinkingPanelUpdate()     // 更新思考面板显示
}

// 统一处理工具结果事件
function handleToolResultLikeEvent(payload) {
  // 如果是首次见到的 toolCallId（跳过了 start 阶段），补充注册
  const synthesized = noteToolCallSeen({ toolCallId: payload.toolCallId })
  if (synthesized) {
    activeTools.push({ name: "Tool", toolCallId: payload.toolCallId, startedAt: now })
    toolCallCount += 1
  }
  removeActiveTool(payload.toolCallId)
  if (activeTools.length === 0 && streamPhase === "tool") {
    streamPhase = streamText ? "streaming" : "idle"
  }
  queueThinkingPanelUpdate()
}
```

### 2. 指令标签的分层剥离策略

```javascript
// 渲染层：仅剥离开头的 reply_to 标签，保留 markdown 结构
function stripLeadingReplyDirectiveForRender(text) {
  // 只处理文本开头的 [[reply_to_current]] 或 [[reply_to:xxx]]
  return text.replace(/^\s*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*/i, "")
}

// 流式渲染路径
function queueStreamingRender() {
  const safeRendered = stripIncompleteAtTag(streamText)
  const displayRendered = stripLeadingReplyDirectiveForRender(safeRendered)  // 渲染时剥离
  const renderedForCard = normalizeMentionTagsForCard(displayRendered)
  // ... 更新卡片
}

// 最终交付路径（closeStreaming + deliver）
function closeStreaming() {
  // 完整剥离所有指令标签（reply_to, audio_as_voice 等）
  const finalText = stripInlineDirectiveTagsForDelivery(streamText).text
  // ... 关闭卡片
}

function deliver(text) {
  text = stripInlineDirectiveTagsForDelivery(text).text  // L1169
  // ... 发送最终消息
}
```

### 3. `mergeStreamingText` 修复

```javascript
// streaming-card.ts — 安全的文本合并
function mergeStreamingText(previousText, nextText) {
  const previous = previousText ?? ""
  const next = nextText ?? ""
  if (!next) return previous
  if (!previous || next === previous) return next
  // 累积快照模式：next 包含完整文本
  if (next.startsWith(previous)) return next
  // 注意：不再检查 previous.startsWith(next) 或 previous.includes(next)
  // 单字符 delta（"|", "\n", "-"）天然是 previous 的子串，会被误吞
  // 也不做尾部重叠检测，避免吃掉表格行间的换行符
  return `${previous}${next}`  // 纯追加
}
```

### 4. CLI Followup 事件路由

```javascript
// agent-runner-execution.ts — followup run 事件回调
const callbacks = {
  onAssistantTurn: (text) => {
    queueAssistantMessageStart()     // 确保 signalMessageStart 仅一次
    queueReasoningEndIfNeeded()
    emitAgentEvent({ stream: "assistant", data: { text } })
    opts.onPartialReply?.({ text })   // 转发到飞书 dispatcher
  },

  onThinkingTurn: (payload) => {
    queueAssistantMessageStart()
    emitAgentEvent({ stream: "thinking", data: payload })
    opts.onReasoningStream?.({ text: formatReasoningMessage(payload.text) })
  },

  onToolUseEvent: (payload) => {
    queueAssistantMessageStart()
    emitAgentEvent({ stream: "tool", data: { phase: "start", name: payload.name, ... } })
    // 转发到 onAgentEvent，飞书 dispatcher 在 onAgentEvent 中处理工具事件
    opts.onAgentEvent?.({ stream: "tool", data: { phase: "start", ... } })
    opts.onToolStart?.({ name: payload.name, phase: "start", toolCallId: payload.toolUseId })
  },

  onToolResult: (payload) => {
    emitAgentEvent({ stream: "tool", data: { phase: "result", ... } })
    opts.onAgentEvent?.({ stream: "tool", data: { phase: "result", ... } })
    onToolResult?.({ toolCallId: payload.toolUseId, text: payload.text })
  },
}
```

## 数据流程图 (Data Flow Diagram)

### 流式卡片生命周期

```
┌──────────────────┐
│  Agent Runner    │
│  (pi-embedded /  │
│   cli-runner)    │
└───────┬──────────┘
        │ onAssistantMessageStart / onReasoningStream / onToolStart / onPartialReply
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Reply Dispatcher (reply-dispatcher.ts)           │
│                                                                      │
│  streamPhase: idle → thinking → tool → streaming → idle              │
│                                                                      │
│  ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐  │
│  │ seenToolCallIds  │   │ activeTools[]    │   │ streamText       │  │
│  │ (去重集合)       │   │ (当前工具列表)   │   │ (累积文本)       │  │
│  └────────┬────────┘   └───────┬──────────┘   └───────┬──────────┘  │
│           │                    │                       │              │
│           ▼                    ▼                       ▼              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              composeThinkingContent()                        │    │
│  │  (组合工具状态 + 思考文本 → 思考面板 markdown)              │    │
│  └─────────────────────────┬───────────────────────────────────┘    │
│                            │                                         │
│  ┌─────────────────────────┼───────────────────────────────────┐    │
│  │  渲染路径：             │  交付路径：                        │    │
│  │  stripLeadingReply...   │  stripInlineDirectiveTags...       │    │
│  │  (仅剥离开头 reply_to)  │  (剥离所有指令标签)               │    │
│  └────────────┬────────────┴────────────┬──────────────────────┘    │
└───────────────┼─────────────────────────┼────────────────────────────┘
                │                         │
                ▼                         ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  Streaming Card Session  │  │  sendMessageFeishu /     │
│  (streaming-card.ts)     │  │  sendStructuredCardFeishu│
│                          │  │  (最终卡片/消息发送)     │
│  updateContent()         │  └──────────────────────────┘
│  updateThinking()        │
│  close()                 │
│                          │
│  mergeStreamingText()    │
│  (纯追加，无子串去重)    │
└──────────┬───────────────┘
           │ Card Kit API (PATCH /open-apis/cardkit)
           ▼
┌──────────────────────────┐
│     飞书客户端            │
│   (流式渲染卡片)          │
└──────────────────────────┘
```

### CLI Followup 事件路由

```
┌──────────────────────────┐
│  CLI Runner (followup)   │
│  executeCliAgentRun()    │
└───────────┬──────────────┘
            │ onAssistantTurn / onThinkingTurn / onToolUseEvent / onToolResult
            ▼
┌───────────────────────────────────────────────────────┐
│  agent-runner-execution.ts                            │
│                                                       │
│  queueAssistantMessageStart()  ←── 确保仅触发一次     │
│  emitAgentEvent()              ←── 广播事件流          │
│                                                       │
│  转发到 replyOptions 回调:                            │
│    opts.onAgentEvent()  → dispatcher.onAgentEvent     │
│    opts.onPartialReply() → dispatcher.onPartialReply  │
│    opts.onToolStart()   → dispatcher.onToolStart      │
│    opts.onReasoningStream() → dispatcher.onReasoning  │
└───────────────────────────────────────────────────────┘
            │
            ▼
┌───────────────────────────────────────────────────────┐
│  Reply Dispatcher                                     │
│  onAgentEvent 监听 stream="tool" 事件                 │
│  → handleToolStartLikeEvent / handleToolResultLikeEvent│
│  → 更新思考面板工具状态                                │
└───────────────────────────────────────────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `extensions/feishu/src/reply-dispatcher.ts` | 378 | `streamPhase` 状态机声明（idle/thinking/tool/streaming） |
| `extensions/feishu/src/reply-dispatcher.ts` | 380 | `seenToolCallIds` 去重集合声明 |
| `extensions/feishu/src/reply-dispatcher.ts` | 382 | `streamingActivityTimer` 流式活跃度定时器声明 |
| `extensions/feishu/src/reply-dispatcher.ts` | 514-534 | `clearStreamingActivityTimer` / `ensureStreamingActivityTimer` 定时器管理 |
| `extensions/feishu/src/reply-dispatcher.ts` | 560-573 | `noteToolCallSeen` 工具调用去重逻辑 |
| `extensions/feishu/src/reply-dispatcher.ts` | 575-604 | `handleToolStartLikeEvent` 统一工具启动处理 |
| `extensions/feishu/src/reply-dispatcher.ts` | 614-648 | `handleToolResultLikeEvent` 统一工具结果处理 |
| `extensions/feishu/src/reply-dispatcher.ts` | 783-788 | `stripLeadingReplyDirectiveForRender` 渲染层指令剥离 |
| `extensions/feishu/src/reply-dispatcher.ts` | 799-801 | 流式渲染中调用 `stripLeadingReplyDirectiveForRender` |
| `extensions/feishu/src/reply-dispatcher.ts` | 942-946 | `closeStreaming` 中切换 `streamPhase` 为 idle 并清除定时器 |
| `extensions/feishu/src/reply-dispatcher.ts` | 957-959 | `closeStreaming` 中 `stripInlineDirectiveTagsForDelivery` 剥离最终文本 |
| `extensions/feishu/src/reply-dispatcher.ts` | 1000-1002 | 思考面板为空时标记为 `close-final-card-drop-status-only-panel` |
| `extensions/feishu/src/reply-dispatcher.ts` | 1169 | `deliver` 路径中 `stripInlineDirectiveTagsForDelivery` 剥离 |
| `extensions/feishu/src/reply-dispatcher.ts` | 1389-1414 | `onAgentEvent` 回调：监听 `stream=tool` 的低级别事件 |
| `extensions/feishu/src/reply-dispatcher.ts` | 1416-1421 | `onAssistantMessageStart` 增加 `queueThinkingPanelUpdate` |
| `extensions/feishu/src/reply-dispatcher.ts` | 1427-1429 | `onReasoningStream` 中 `stripInlineDirectiveTagsForDisplay` |
| `extensions/feishu/src/reply-dispatcher.ts` | 1448-1458 | `onToolStart` / `onToolResult` 委托给统一处理函数 |
| `extensions/feishu/src/reply-dispatcher.ts` | 1460-1481 | `onPartialReply` 保留原始文本，指令剥离延迟到最终交付 |
| `extensions/feishu/src/streaming-card.ts` | 132-165 | `mergeStreamingText` 重写：去掉子串去重和重叠检测 |
| `extensions/feishu/src/streaming-card.ts` | 226 | `streaming_config` 参数调整为 `print_frequency_ms: 30, print_step: 50` |
| `extensions/feishu/src/streaming-card.ts` | 486 | `buildFullElements` 直接使用 `text` 而非 `sanitizeVisibleCardText` |
| `extensions/feishu/src/send.ts` | 308-343 | `enrichMentionPlaceholders` 替换 `@_user_N` 占位符 |
| `extensions/feishu/src/send.ts` | 777-810 | `buildStructuredCard` 支持思考面板可折叠参数 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 798-934 | CLI followup 回调：`onSystemInit` / `onAssistantTurn` / `onThinkingTurn` / `onToolUseEvent` / `onToolResult` |
| `src/auto-reply/types.ts` | 155 | `GetReplyOptions` 新增 `onAgentEvent` 回调 |
