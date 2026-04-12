# Patch 09: 飞书话题线程绑定管理器与 Followup 队列路由

## 为什么要改 (Why)

### 问题 1: 子 Agent 会话缺少话题线程生命周期管理

飞书的话题线程（topic thread）是 subagent 和 ACP 会话的天然承载容器：一个话题 = 一个会话。但之前没有绑定管理机制，subagent 创建后无法将其会话与特定话题线程关联。用户在话题线程中发送的消息无法被路由到正确的 subagent session，也没有超时自动解绑、空闲清理等生命周期能力。

### 问题 2: Followup 队列消息以轻量级模式发送，缺少流式 UX

当用户连续发送多条消息时，agent 忙碌期间的消息会被排队（followup queue）。排队消息被消费时，走的是轻量级路径（一次性发送完整回复），不经过飞书的流式卡片和 typing indicator。用户体验为：消息发出后无任何反馈，等待很久后突然出现完整回复，没有思考过程展示。

### 问题 3: 绑定状态没有持久化

服务重启后所有线程绑定关系丢失，正在进行的 subagent 会话被中断。需要将绑定状态持久化到磁盘（`~/.openclaw/feishu/thread-bindings.json`），并在启动时恢复。

### 问题 4: 绑定适配器未注册到全局 SessionBinding 系统

OpenClaw 有统一的 `SessionBindingAdapter` 接口用于跨渠道的会话绑定管理。飞书的线程绑定需要注册为标准适配器，才能被 subagent 调度系统发现和使用（bind/unbind/resolve/touch）。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/thread-bindings.types.ts` | 新文件。定义 `FeishuThreadBindingRecord` 类型（accountId、chatId、rootId、targetSessionKey、agentId、boundAt、lastActivityAt、idleTimeoutMs、maxAgeMs）；定义默认超时常量（空闲 24h，最大存活期 0 = 禁用，清扫间隔 120s，touch 持久化最小间隔 15s） |
| `extensions/feishu/src/thread-bindings.state.ts` | 新文件。全局状态管理（`BINDINGS_BY_KEY` / `BINDINGS_BY_SESSION` 双索引 Map）；`setBindingRecord` / `removeBindingRecord` CRUD 操作维护双索引一致性；`saveBindingsToDisk` 原子写入（tmp+rename）；`ensureBindingsLoaded` 启动时恢复；路径解析 `~/.openclaw/feishu/thread-bindings.json` |
| `extensions/feishu/src/thread-bindings.manager.ts` | 新文件（516 行）。`createFeishuThreadBindingManager` 工厂函数：单例注册（globalThis 防重复）；`bind()` 发送 intro 消息创建线程锚点 + 话题内回复激活 UI 线程；`unbind()` 移除绑定并发送 farewell 消息；`touch()` 更新 lastActivityAt；`listBySessionKey()` 按 session 查询；清扫定时器自动 unbind 超时绑定；注册为 `SessionBindingAdapter`（支持 current/child placement） |
| `extensions/feishu/src/thread-bindings.manager.test.ts` | 399 行测试覆盖：bind/unbind/touch 操作、sweep 超时清理、session adapter 注册、重复管理器防护、farewell 消息发送 |
| `extensions/feishu/src/thread-bindings.state.test.ts` | 127 行测试覆盖：双索引一致性、持久化写入/加载、路径解析 |
| `extensions/feishu/src/bot.ts` | 新增 `dispatchFullFollowupTurn` 回调（~100 行）：为 followup 队列消息创建完整的飞书 reply dispatcher（包含流式卡片、typing、thinking panel），通过 `core.channel.reply.withReplyDispatcher` 执行完整调度流程 |
| `src/auto-reply/reply/followup-runner.ts` | `createFollowupRunner` 返回的 runner 函数在执行前检查 `opts.dispatchFullFollowupTurn`；如果渠道提供了完整调度回调，优先委托给它，失败时 fallback 到轻量级路径 |
| `src/auto-reply/types.ts` | `GetReplyOptions` 新增 `dispatchFullFollowupTurn` 回调类型声明 |

## 伪代码 (Pseudocode)

### 1. 线程绑定状态管理（双索引）

```javascript
// thread-bindings.state.ts — globalThis 单例状态
const BINDINGS_BY_KEY = new Map()      // "accountId:chatId:rootId" → FeishuThreadBindingRecord
const BINDINGS_BY_SESSION = new Map()  // "targetSessionKey" → Set<bindingKey>

function setBindingRecord(record) {
  const key = toBindingKey(record.accountId, record.chatId, record.rootId)
  // 维护双索引一致性：先解除旧 session 链接
  const previous = BINDINGS_BY_KEY.get(key)
  if (previous) {
    unlinkSession(previous.targetSessionKey, key)
  }
  BINDINGS_BY_KEY.set(key, record)
  linkSession(record.targetSessionKey, key)  // 建立新 session 链接
}

function removeBindingRecord(bindingKey) {
  const existing = BINDINGS_BY_KEY.get(bindingKey)
  if (!existing) return null
  BINDINGS_BY_KEY.delete(bindingKey)
  unlinkSession(existing.targetSessionKey, bindingKey)
  return existing
}

// 持久化：原子写入（写 tmp → rename）
function saveBindingsToDisk({ force, minIntervalMs }) {
  if (!force && (now - lastPersistedAt) < minIntervalMs) return  // 节流
  const payload = { version: 1, bindings: Object.fromEntries(BINDINGS_BY_KEY) }
  const tmpPath = `${filePath}.tmp.${process.pid}`
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2))
  fs.renameSync(tmpPath, filePath)  // 原子替换
}
```

### 2. 绑定管理器（bind/unbind 生命周期）

```javascript
// thread-bindings.manager.ts
function createFeishuThreadBindingManager(params) {
  // 单例：同一 accountId 复用
  const existing = MANAGERS_BY_ACCOUNT.get(accountId)
  if (existing) return existing

  const manager = {
    // 创建绑定：发送 intro 消息获取 rootId → 话题内回复激活线程
    bind: async ({ chatId, targetSessionKey, introText, ... }) => {
      // 1. 发送 intro 消息到群聊，获取 messageId 作为线程锚点
      const result = await sendMessageFeishu({
        to: `chat:${chatId}`,
        text: introText || "Thread created.",
      })
      const rootId = result.messageId

      // 2. 在线程内回复，激活飞书 UI 的话题线程
      await sendMessageFeishu({
        to: `chat:${chatId}`,
        text: "Listening in this thread.",
        replyToMessageId: rootId,
        replyInThread: true,
      })

      // 3. 创建绑定记录
      const record = {
        accountId, chatId, rootId,
        targetKind, targetSessionKey, agentId,
        boundAt: now, lastActivityAt: now,
        idleTimeoutMs, maxAgeMs,
      }
      setBindingRecord(record)
      saveBindingsToDisk({ force: true })
      return record
    },

    // 解除绑定：移除记录 + 发送 farewell 消息
    unbind: (chatId, rootId, opts) => {
      const removed = removeBindingRecord(toBindingKey(accountId, chatId, rootId))
      if (!removed) return null
      saveBindingsToDisk({ force: true })
      if (opts.sendFarewell !== false) {
        sendMessageFeishu({
          to: `chat:${removed.chatId}`,
          text: opts.farewellText || "Thread binding ended.",
          replyToMessageId: removed.rootId,
          replyInThread: true,
        })
      }
      return removed
    },

    // 更新活跃时间
    touch: (chatId, rootId, at) => {
      const record = getByKey(chatId, rootId)
      record.lastActivityAt = Math.max(record.lastActivityAt, at ?? now)
      setBindingRecord(record)
      saveBindingsToDisk({ minIntervalMs: 15_000 })  // 节流持久化
    },
  }

  // 启动清扫定时器（每 120 秒）
  sweepTimer = setInterval(() => {
    for (const binding of manager.listBindings()) {
      const idleExpires = binding.lastActivityAt + binding.idleTimeoutMs
      const maxAgeExpires = binding.boundAt + binding.maxAgeMs
      if (now >= idleExpires || now >= maxAgeExpires) {
        manager.unbind(binding.chatId, binding.rootId, {
          reason: "idle-expired",
          sendFarewell: true,
        })
      }
    }
  }, 120_000)

  // 注册为全局 SessionBindingAdapter
  registerSessionBindingAdapter({
    channel: "feishu",
    accountId,
    capabilities: { placements: ["current", "child"] },
    bind: async (input) => { /* 委托给 manager.bind() */ },
    resolveByConversation: (ref) => { /* 通过 chatId:rootId 查询 */ },
    touch: (bindingId, at) => { /* 委托给 manager.touch() */ },
    unbind: async (input) => { /* 委托给 manager.unbind() */ },
  })

  return manager
}
```

### 3. Followup 队列的完整飞书调度

```javascript
// bot.ts — dispatchFullFollowupTurn 回调
const dispatchFullFollowupTurn = async (queued) => {
  if (queued.originatingChannel !== "feishu") return false

  // 1. 为排队消息创建独立的 reply dispatcher
  //    （包含流式卡片、thinking panel、typing indicator）
  const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
    cfg,
    agentId: queued.run.agentId,
    chatId: queued.originatingTo ?? feishuTo,
    replyToMessageId: queued.messageId,
    replyInThread: Boolean(queued.originatingThreadId),
    // ... 完整参数
  })

  // 2. 构造 followup 的 inbound context
  const followupCtx = core.channel.reply.finalizeInboundContext({
    Body: queued.prompt,
    From: queued.run.senderId,
    To: followupChatId,
    SessionKey: queued.run.sessionKey ?? effectiveSessionKey,
    // ... 完整上下文
  })

  // 3. 通过标准调度流程执行
  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => markDispatchIdle(),
    run: () => core.channel.reply.dispatchReplyFromConfig({
      ctx: followupCtx,
      cfg,
      dispatcher,
      replyOptions: { ...replyOptions, dispatchFullFollowupTurn },  // 递归支持
    }),
  })

  return true  // 告知 followup-runner 已处理
}
```

### 4. Followup Runner 优先委托

```javascript
// followup-runner.ts — 优先尝试完整调度
return async (queued) => {
  // 如果渠道提供了完整调度回调，优先使用
  if (opts.dispatchFullFollowupTurn && queued.originatingChannel) {
    try {
      const handled = await opts.dispatchFullFollowupTurn(queued)
      if (handled) {
        typing.markRunComplete()
        typing.markDispatchIdle()
        return  // 完整调度成功，跳过轻量级路径
      }
    } catch (err) {
      // 完整调度失败，fallback 到轻量级路径
      logVerbose(`followup full dispatch failed, falling back: ${err}`)
    }
  }

  // 轻量级路径：一次性发送完整回复
  const replyOperation = createReplyOperation({ ... })
  // ...
}
```

## 数据流程图 (Data Flow Diagram)

### 线程绑定状态机

```
              bind()
  ┌────────────────────────────┐
  │                            ▼
  │   ┌─────────────────────────────────┐
  │   │         IDLE (无绑定)           │
  │   └─────────────────────────────────┘
  │              │ bind()
  │              │  1. sendMessage → rootId
  │              │  2. replyInThread 激活
  │              │  3. setBindingRecord
  │              ▼
  │   ┌─────────────────────────────────┐
  │   │        ACTIVE (已绑定)          │
  │   │                                 │
  │   │  lastActivityAt ← touch()      │
  │   │  sweeper 每 120s 检查超时       │
  │   │                                 │
  │   │  超时条件:                      │
  │   │  - idleTimeout (默认 24h)       │
  │   │  - maxAge (默认禁用)            │
  │   └─────────────────────────────────┘
  │              │ unbind() 或 sweep 超时
  │              │  1. removeBindingRecord
  │              │  2. saveBindingsToDisk
  │              │  3. sendFarewell
  │              ▼
  │   ┌─────────────────────────────────┐
  │   │       COMPLETING (已解绑)       │
  └───│  farewell 消息发送到话题线程    │
      └─────────────────────────────────┘
```

### 双索引数据结构

```
BINDINGS_BY_KEY (主索引)
┌────────────────────────────────────┬─────────────────────────┐
│ key: "main:oc_chat1:om_root1"     │ FeishuThreadBindingRecord│
│ key: "main:oc_chat1:om_root2"     │ FeishuThreadBindingRecord│
│ key: "main:oc_chat2:om_root3"     │ FeishuThreadBindingRecord│
└────────────────────────────────────┴─────────────────────────┘

BINDINGS_BY_SESSION (反向索引)
┌───────────────────────────────────────┬──────────────────────────────────┐
│ key: "agent:subagent1:feishu:..."     │ Set { "main:oc_chat1:om_root1" }│
│ key: "agent:subagent2:feishu:..."     │ Set { "main:oc_chat1:om_root2", │
│                                       │        "main:oc_chat2:om_root3" }│
└───────────────────────────────────────┴──────────────────────────────────┘
```

### Followup 队列完整调度路由

```
┌──────────────────────┐
│  用户发送消息        │
│  (agent 忙碌中)      │
└──────────┬───────────┘
           │ 入队
           ▼
┌──────────────────────┐
│  Followup Queue      │
│  (排队等待)          │
└──────────┬───────────┘
           │ agent 空闲，消费队列
           ▼
┌──────────────────────────────────────────────────────────┐
│  followup-runner.ts                                      │
│                                                          │
│  if (dispatchFullFollowupTurn && originatingChannel)     │
│    ├── 尝试完整调度 ──────────────────┐                  │
│    │                                   ▼                  │
│    │                    ┌──────────────────────────┐      │
│    │                    │  bot.ts                   │      │
│    │                    │  dispatchFullFollowupTurn │      │
│    │                    │                          │      │
│    │                    │  1. createFeishuReply     │      │
│    │                    │     Dispatcher()          │      │
│    │                    │     (流式卡片+思考面板)   │      │
│    │                    │                          │      │
│    │                    │  2. finalizeInbound       │      │
│    │                    │     Context()             │      │
│    │                    │                          │      │
│    │                    │  3. withReplyDispatcher() │      │
│    │                    │     → dispatchReply       │      │
│    │                    │       FromConfig()        │      │
│    │                    └──────────┬───────────────┘      │
│    │                               │ return true          │
│    │    ◀──────────────────────────┘                      │
│    │    markRunComplete + markDispatchIdle                │
│    │                                                      │
│    └── 失败时 fallback ──────────────┐                   │
│                                       ▼                   │
│                          ┌────────────────────────┐       │
│                          │  轻量级路径            │       │
│                          │  (一次性发送完整回复)  │       │
│                          └────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

### 持久化存储

```
~/.openclaw/
  └── feishu/
      └── thread-bindings.json      ← 原子写入 (tmp + rename)
          {
            "version": 1,
            "bindings": {
              "main:oc_chat1:om_root1": {
                "accountId": "main",
                "chatId": "oc_chat1",
                "rootId": "om_root1",
                "targetSessionKey": "agent:sub1:feishu:...",
                "targetKind": "subagent",
                "agentId": "sub1",
                "boundAt": 1712937600000,
                "lastActivityAt": 1712941200000,
                "idleTimeoutMs": 86400000,
                "maxAgeMs": 0
              }
            }
          }
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `extensions/feishu/src/thread-bindings.types.ts` | 1-2 | `FeishuThreadBindingTargetKind` 类型定义（"subagent" / "acp"） |
| `extensions/feishu/src/thread-bindings.types.ts` | 4-16 | `FeishuThreadBindingRecord` 完整类型定义 |
| `extensions/feishu/src/thread-bindings.types.ts` | 23-27 | 默认常量：`FEISHU_THREAD_BINDINGS_VERSION=1`，sweep 间隔 120s，空闲超时 24h，最大存活期 0，touch 持久化节流 15s |
| `extensions/feishu/src/thread-bindings.state.ts` | 14-22 | `FeishuThreadBindingsGlobalState` 类型（双索引 Map + persist 配置） |
| `extensions/feishu/src/thread-bindings.state.ts` | 53-54 | `BINDINGS_BY_KEY` / `BINDINGS_BY_SESSION` 导出 |
| `extensions/feishu/src/thread-bindings.state.ts` | 60-66 | `toBindingKey` / `toConversationId` / `parseConversationId` 键值工具函数 |
| `extensions/feishu/src/thread-bindings.state.ts` | 94-106 | `setBindingRecord` 维护双索引一致性 |
| `extensions/feishu/src/thread-bindings.state.ts` | 108-114 | `removeBindingRecord` 双索引删除 |
| `extensions/feishu/src/thread-bindings.state.ts` | 145-157 | `saveBindingsToDisk` 原子写入（tmp + rename）带节流 |
| `extensions/feishu/src/thread-bindings.state.ts` | 169-196 | `ensureBindingsLoaded` 启动时从磁盘恢复绑定 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 33-40 | `resolveAgentIdFromSessionKey` 从 sessionKey 提取 agentId |
| `extensions/feishu/src/thread-bindings.manager.ts` | 94-109 | `toSessionBindingRecord` 转换为统一 `SessionBindingRecord` 格式 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 131 | `MANAGERS_BY_ACCOUNT` 单例注册表（globalThis 存储） |
| `extensions/feishu/src/thread-bindings.manager.ts` | 173-180 | `createFeishuThreadBindingManager` 工厂函数入口与单例检查 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 229-271 | `bind()` 实现：发送 intro 消息 → 话题内回复激活 → 创建记录 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 273-283 | `unbind()` 实现：移除记录 + farewell 消息 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 285-298 | `unbindBySessionKey()` 按 session 批量解绑 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 313-339 | sweeper 定时器：遍历绑定检查 idle/maxAge 超时 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 345-346 | `registerSessionBindingAdapter` 注册飞书为全局绑定适配器 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 347 | `capabilities: { placements: ["current", "child"] }` |
| `extensions/feishu/src/thread-bindings.manager.ts` | 349-401 | adapter `bind` 实现：支持 current（绑定现有线程）和 child（创建新线程） |
| `extensions/feishu/src/thread-bindings.manager.ts` | 403-404 | adapter `listBySession` 实现 |
| `extensions/feishu/src/thread-bindings.manager.ts` | 406-411 | adapter `resolveByConversation` 通过 conversationId 查询 |
| `extensions/feishu/src/bot.ts` | 1498-1500 | `dispatchFullFollowupTurn` 回调声明与注释 |
| `extensions/feishu/src/bot.ts` | 1501-1502 | `originatingChannel` 判断：仅处理飞书来源的排队消息 |
| `extensions/feishu/src/bot.ts` | 1533-1556 | 为 followup 消息创建独立的 `createFeishuReplyDispatcher` |
| `extensions/feishu/src/bot.ts` | 1558-1584 | `finalizeInboundContext` 构造 followup 上下文 |
| `extensions/feishu/src/bot.ts` | 1586-1595 | `withReplyDispatcher` + `dispatchReplyFromConfig` 完整调度 |
| `extensions/feishu/src/bot.ts` | 1603 | 主调度传入 `dispatchFullFollowupTurn` 到 `replyOptions` |
| `src/auto-reply/reply/followup-runner.ts` | 139-141 | followup runner 优先委托注释 |
| `src/auto-reply/reply/followup-runner.ts` | 142-156 | `dispatchFullFollowupTurn` 尝试 + fallback 逻辑 |
| `src/auto-reply/types.ts` | 157-163 | `dispatchFullFollowupTurn` 回调类型声明与 JSDoc |
