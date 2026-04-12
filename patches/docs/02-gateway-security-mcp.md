# Patch 02: Gateway 节点命令覆写策略、MCP 桥接 schema 合并、会话归档与 visible-text 持久化

## 为什么要改 (Why)

### 问题 1: 节点命令策略缺少 per-node override 能力

`resolveNodeCommandAllowlist` 只支持全局 `gateway.nodes.allowCommands` / `denyCommands`，无法对特定节点（按 nodeId 或 displayName）单独配置命令白名单/黑名单。多节点部署场景下，不同设备需要不同的命令权限（例如只允许 Mac 节点执行 `system.camera`，但禁止 Windows 节点执行），全局策略粒度不够。

### 问题 2: MCP HTTP schema 合并在 enum+const 场景下丢失枚举值

`flattenUnionSchema` 在合并 `anyOf` 变体时，遇到一个变体使用 `enum: ["a", "b"]`、另一个使用 `const: "c"` 的情况无法合并，直接丢弃后续变体并发出警告。这导致 MCP loopback tool 的输入 schema 不完整，工具调用时部分合法值被拒绝。

### 问题 3: assistant visible-text 在流式传输后被最终快照覆盖截断

streaming 过程中用户已经看到较长的文本前缀，但最终 `final` 快照可能因为模型返回的 `text` 字段重新从头开始计算而变短。此时直接用 `final` 覆盖 `stream` 会让用户看到的内容突然缩短。需要一个合并策略：当最终文本是新的且不是流式前缀时，将两者智能拼接。

### 问题 4: chat sanitize 不识别 `input_text` / `output_text` 内容类型

OpenAI Responses API 使用 `input_text` 和 `output_text` 作为 content block 的 `type`，而 `stripEnvelopeFromContentWithRole` 只处理 `type: "text"`，导致这些内容块中的信封元数据未被清理，泄漏到 UI 展示。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/gateway/node-command-policy.ts` | `resolveNodeCommandAllowlist` 支持 `nodeId`/`displayName` 参数；新增 `resolveNodeOverride` 按 nodeId 精确匹配 -> displayName 匹配 -> nodeId 前缀匹配（最长前缀优先）查找 per-node override；合并 global + per-node allow/deny |
| `src/gateway/mcp-http.schema.ts` | `flattenUnionSchema` 新增 `enum+const` 双向合并逻辑；相同 `type` 不同 `description` 视为兼容直接保留第一个 |
| `src/gateway/chat-visible-text-persistence.ts` | 新增模块：`persistVisibleAssistantTextToTranscript` 在 chat final 阶段将 visible text 回写到 session transcript，使用 `mergeAssistantVisibleText` 合并流式文本与最终快照 |
| `src/gateway/chat-visible-text-persistence.test.ts` | visible-text 持久化的完整测试覆盖 |
| `src/shared/assistant-visible-text-merge.ts` | 新增模块：`mergeAssistantVisibleText` 智能合并策略（前缀关系保留长文本、非前缀关系拼接去重重叠部分）；`appendUniqueVisibleTextSuffix` 处理重叠拼接和 CJK/ASCII 分隔符推断 |
| `src/shared/assistant-visible-text-merge.test.ts` | 合并策略测试：ASCII 空格、CJK 标点、重叠去重、前缀保留 |
| `src/gateway/server-chat.ts` | `resolveMergedAssistantText` 使用 `mergeAssistantVisibleText` 替代直接覆盖；chat `done` 阶段调用 `persistVisibleAssistantTextToTranscript` |
| `src/gateway/server-chat.agent-events.test.ts` | agent event 处理的新测试 |
| `src/gateway/chat-sanitize.ts` | `stripEnvelopeFromContentWithRole` 增加 `input_text` 和 `output_text` 类型识别 |
| `src/gateway/chat-sanitize.test.ts` | sanitize 新类型的测试 |
| `src/gateway/server-methods/chat.ts` | `transcriptHasIdempotencyKey` 改为调用 `transcript.ts` 导出的 `transcriptFindIdempotencyKey`，消除重复实现 |
| `src/gateway/session-archive.runtime.ts` | 导出源从 `session-archive.fs.ts` 改为 `session-transcript-files.fs.ts`；导出顺序调整为字母序 |
| `src/gateway/session-archive.fs.ts` | 删除 7 行冗余代码 |
| `src/gateway/session-transcript-files.fs.ts` | 微调（runtime import 路径变更的配套修改） |
| `src/gateway/node-connect-reconcile.ts` | 适配新的 node session 类型签名 |
| `src/gateway/server-methods/nodes.ts` | 适配新的 node session 类型签名 |
| `src/gateway/gateway-misc.test.ts` | per-node override 命令策略的全面测试 |
| `ui/src/ui/controllers/chat.ts` | 引入 `mergeAssistantVisibleText`；新增 `mergeAssistantMessageWithStream` 在 `final`/`aborted` 阶段合并流式文本；`delta` 阶段使用 `mergeAssistantVisibleText` 累积 |
| `ui/src/ui/controllers/chat.test.ts` | UI 侧合并逻辑的测试 |

## 伪代码 (Pseudocode)

### 1. 节点命令覆写策略解析 (resolveNodeCommandAllowlist)

```javascript
// src/gateway/node-command-policy.ts:177
function resolveNodeCommandAllowlist(cfg, node) {
  const platformId = normalizePlatformId(node?.platform, node?.deviceFamily)
  const base = PLATFORM_DEFAULTS[platformId]

  // 全局配置
  const extraGlobal = cfg.gateway?.nodes?.allowCommands ?? []
  const denyGlobal  = cfg.gateway?.nodes?.denyCommands ?? []

  // Per-node override 查找
  const override = resolveNodeOverride(cfg, node)
  const extraNode = override?.allowCommands ?? []
  const denyNode  = override?.denyCommands ?? []

  // 合并: 平台默认 + 全局 allow + per-node allow
  const allow = new Set([...base, ...extraGlobal, ...extraNode])

  // 移除: 全局 deny + per-node deny
  for (const cmd of [...denyGlobal, ...denyNode]) {
    allow.delete(cmd.trim())
  }
  return allow
}
```

### 2. Per-node Override 查找 (resolveNodeOverride)

```javascript
// src/gateway/node-command-policy.ts:232
function resolveNodeOverride(cfg, node) {
  const overrides = cfg.gateway?.nodes?.overrides
  if (!overrides || !node) return undefined

  // 策略 1: nodeId 精确匹配
  if (node.nodeId && overrides[node.nodeId])
    return overrides[node.nodeId]

  // 策略 2: displayName 精确匹配
  if (node.displayName && overrides[node.displayName])
    return overrides[node.displayName]

  // 策略 3: nodeId 前缀匹配（最长前缀优先）
  if (node.nodeId) {
    let bestKey = undefined
    for (const key of Object.keys(overrides)) {
      if (key && node.nodeId.startsWith(key)) {
        if (!bestKey || key.length > bestKey.length)
          bestKey = key
      }
    }
    if (bestKey) return overrides[bestKey]
  }
  return undefined
}
```

### 3. MCP Schema enum+const 合并

```javascript
// src/gateway/mcp-http.schema.ts:73
function flattenUnionSchema(raw) {
  // ... 遍历 anyOf 变体合并 properties ...
  for (const [key, incoming] of Object.entries(variantProps)) {
    const existing = mergedProps[key]

    // 已有 enum + 新来 const -> 追加到 enum 数组
    if (Array.isArray(existing.enum) && "const" in incoming) {
      mergedProps[key] = {
        ...existing,
        enum: [...new Set([...existing.enum, incoming.const])]
      }
      continue
    }
    // 已有 const + 新来 enum -> 合并为 enum 数组
    if ("const" in existing && Array.isArray(incoming.enum)) {
      mergedProps[key] = {
        ...incoming,
        enum: [...new Set([existing.const, ...incoming.enum])]
      }
      continue
    }
    // 相同基础 type，不同 description -> 兼容，保留第一个
    if (existing.type && existing.type === incoming.type) {
      continue
    }
    // 不兼容时警告
    logWarn(`conflicting schema for "${key}", keeping first variant`)
  }
}
```

### 4. Assistant Visible-Text 合并策略

```javascript
// src/shared/assistant-visible-text-merge.ts:47
function mergeAssistantVisibleText(previousText, nextText) {
  if (!previousText) return nextText
  if (!nextText) return previousText

  // 情况 1: nextText 是 previousText 的延续 -> 取更长的
  if (nextText.startsWith(previousText)) return nextText

  // 情况 2: previousText 是 nextText 的延续 -> 保留已展示的更长文本
  if (previousText.startsWith(nextText)) return previousText

  // 情况 3: 两者无前缀关系 -> 拼接（自动去重重叠部分）
  return appendUniqueVisibleTextSuffix(previousText, nextText)
}

// src/shared/assistant-visible-text-merge.ts:28
function appendUniqueVisibleTextSuffix(base, suffix) {
  // 检查尾部重叠: "Hello wor" + "world" -> "Hello world"
  for (let overlap = min(base.length, suffix.length); overlap > 0; overlap--) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap)
    }
  }
  // 无重叠时根据字符类型决定分隔符
  const separator = resolveVisibleTextSeparator(base, suffix)
  return base + separator + suffix
}
```

### 5. Chat Final 阶段 visible-text 持久化

```javascript
// src/gateway/chat-visible-text-persistence.ts:8
function persistVisibleAssistantTextToTranscript({ sessionFile, sessionKey, visibleText }) {
  if (!visibleText.trim() || isSilentReplyText(visibleText)) return false

  const sessionManager = SessionManager.open(sessionFile)
  const branch = sessionManager.getBranch()
  // 找到最近的 assistant 消息
  const target = branch.toReversed().find(e => e.message.role === "assistant")
  if (!target) return false

  // 提取已有 visible text 并合并
  const existingText = extractAssistantVisibleText(target.message)
  const mergedText = mergeAssistantVisibleText(visibleText, existingText)

  if (!mergedText || existingText === mergedText) return false

  // 回写到 transcript
  rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: [{
      entryId: target.id,
      message: { ...target.message, text: mergedText }
    }]
  })
  emitSessionTranscriptUpdate({ sessionFile, sessionKey })
  return true
}
```

## 数据流程图 (Data Flow Diagram)

### 节点命令策略解析流程

```
                    ┌─────────────────────────────┐
                    │       OpenClawConfig         │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
┌──────────────────┐ ┌─────────────────┐ ┌──────────────────────┐
│ gateway.nodes.   │ │ gateway.nodes.  │ │ gateway.nodes.       │
│ allowCommands    │ │ denyCommands    │ │ overrides             │
│ (全局 allow)     │ │ (全局 deny)     │ │ { "mac-*": {...},    │
└────────┬─────────┘ └───────┬─────────┘ │   "win-01": {...} }  │
         │                   │           └──────────┬───────────┘
         │                   │                      │
         │                   │        resolveNodeOverride(cfg, node)
         │                   │        ┌─────────────┤
         │                   │        │ 1. nodeId 精确匹配
         │                   │        │ 2. displayName 匹配
         │                   │        │ 3. nodeId 前缀匹配
         │                   │        └─────────────┤
         │                   │                      │
         ▼                   ▼                      ▼
┌──────────────────────────────────────────────────────────┐
│              resolveNodeCommandAllowlist                  │
│                                                          │
│  allow = PLATFORM_DEFAULTS ∪ globalAllow ∪ nodeAllow     │
│  deny  = globalDeny ∪ nodeDeny                           │
│  result = allow \ deny                                   │
└──────────────────────────────────────────────────────────┘
```

### Visible-Text 合并与持久化流程

```
┌──────────────┐    delta 事件         ┌────────────────────────┐
│  Agent Run   │──────────────────────>│  Gateway server-chat   │
│  (streaming) │                       │  mergeAssistantVisible  │
│              │    final 事件         │  Text(prev, next)      │
│              │──────────────────────>│                        │
└──────────────┘                       └───────────┬────────────┘
                                                   │
                  ┌────────────────────────────────┤
                  ▼                                ▼
    ┌─────────────────────────┐    ┌──────────────────────────────┐
    │  UI Controller (chat.ts)│    │  persistVisibleAssistantText │
    │  mergeAssistantMessage  │    │  ToTranscript()              │
    │  WithStream()           │    │                              │
    │                         │    │  1. 找到最近 assistant entry  │
    │  stream: "Hello wor"    │    │  2. merge(visibleText,       │
    │  final:  "world"        │    │          existingText)       │
    │  合并:   "Hello world"  │    │  3. 回写 transcript JSONL   │
    └─────────────────────────┘    └──────────────────────────────┘

                  合并策略 (mergeAssistantVisibleText):
    ┌────────────────────────────────────────────────────────┐
    │  A startsWith B  ->  return A  (保留更长已展示内容)     │
    │  B startsWith A  ->  return B  (正常追加增长)          │
    │  otherwise       ->  appendUniqueVisibleTextSuffix     │
    │                      (去重重叠 + 推断分隔符)           │
    └────────────────────────────────────────────────────────┘
```

### MCP Schema 合并流程

```
┌────────────────────────────────┐
│  MCP Tool Input Schema         │
│  {                             │
│    anyOf: [                    │
│      { props: { mode: {       │
│          enum: ["a", "b"] }}}, │
│      { props: { mode: {       │
│          const: "c" }}}       │
│    ]                           │
│  }                             │
└──────────────┬─────────────────┘
               │ flattenUnionSchema()
               ▼
┌────────────────────────────────┐
│  合并后 Schema                  │
│  {                             │
│    props: { mode: {            │
│      enum: ["a", "b", "c"]    │
│    }}                          │
│  }                             │
└────────────────────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/gateway/node-command-policy.ts` | 166 | `function normalizePlatformId()` - 平台 ID 标准化 |
| `src/gateway/node-command-policy.ts` | 177 | `export function resolveNodeCommandAllowlist()` - 命令白名单解析（含 per-node） |
| `src/gateway/node-command-policy.ts` | 232 | `function resolveNodeOverride()` - per-node override 三级查找 |
| `src/gateway/mcp-http.schema.ts` | 73 | `function flattenUnionSchema()` - anyOf schema 合并（含 enum+const） |
| `src/gateway/chat-visible-text-persistence.ts` | 8 | `export function persistVisibleAssistantTextToTranscript()` - visible text 回写 transcript |
| `src/shared/assistant-visible-text-merge.ts` | 28 | `export function appendUniqueVisibleTextSuffix()` - 重叠去重拼接 |
| `src/shared/assistant-visible-text-merge.ts` | 47 | `export function mergeAssistantVisibleText()` - 合并策略主入口 |
| `src/gateway/server-chat.ts` | 131 | `resolveMergedAssistantText()` - 使用新合并策略替代直接覆盖 |
| `src/gateway/server-chat.ts` | 663-678 | chat `done` 阶段调用 `persistVisibleAssistantTextToTranscript` |
| `src/gateway/chat-sanitize.ts` | 47-49 | `stripEnvelopeFromContentWithRole` 增加 `input_text`/`output_text` |
| `src/gateway/server-methods/chat.ts` | 819 | `transcriptHasIdempotencyKey` 改为调用共享 `transcriptFindIdempotencyKey` |
| `src/gateway/session-archive.runtime.ts` | 1-5 | 导出源更改为 `session-transcript-files.fs.ts` |
| `ui/src/ui/controllers/chat.ts` | 1 | 引入 `mergeAssistantVisibleText` |
| `ui/src/ui/controllers/chat.ts` | 17-39 | `mergeAssistantMessageWithStream()` - UI 侧 final/stream 合并 |
| `ui/src/ui/controllers/chat.ts` | 319 | delta 阶段使用 `mergeAssistantVisibleText` 累积流式文本 |
| `ui/src/ui/controllers/chat.ts` | 322-330 | final 阶段使用 `mergeAssistantMessageWithStream` 合并 |
| `ui/src/ui/controllers/chat.ts` | 343-349 | aborted 阶段同样使用合并策略 |
