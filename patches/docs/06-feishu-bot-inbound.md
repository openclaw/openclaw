# Patch 06: 飞书机器人入站消息处理 — @ 提及、引用消息、撤回、发送者名称

## 为什么要改 (Why)

### 问题 1: @ 提及标签级联替换导致文本损坏

飞书消息中 `<at user_id="ou_xxx">Name</at>` 标签在转发给 streaming card 时需要转换为 `<at id=ou_xxx></at>` 格式。旧实现使用逐个 `String.replace()` 按 mention 列表替换，当一个用户的 open_id 是另一个的子串时，会产生级联替换错误。同时，在多 bot 场景下，只检查单个 `botOpenId` 来过滤 bot 自身的 mention，导致其他 bot 的 mention 也被当作人类用户处理。

### 问题 2: 引用消息内容无法解析

用户在飞书中引用（回复）一条消息时，飞书 API 只提供被引用消息的 `message_id`（即 `parent_id`），不携带消息内容。要展示引用内容，必须额外调用 API 获取。但 API 调用慢且有频率限制，对于 bot 自己发出的消息，完全可以从本地 session transcript 中直接查找。

### 问题 3: 消息撤回事件未处理

飞书的 `im.message.recalled_v1` 事件被完全忽略，运维无法得知消息被撤回的情况。需要至少记录撤回日志，包括操作者、消息 ID、会话 ID 等关键信息。

### 问题 4: bot 发送者名称查询在权限不足时反复失败

调用飞书 API 获取用户名称时，如果 app 缺少 `contact:user.base:readonly` 权限（错误码 41050），每条消息都会触发一次注定失败的 API 调用。需要 backoff 机制避免无意义的重复请求。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/mention.ts` | 基于正则的 mention 标签归一化（避免级联替换）；多 bot open_id 集合过滤 |
| `extensions/feishu/src/quoted-message.ts` | 新文件：4 层引用消息解析（live session → disk session → DB → API） |
| `extensions/feishu/src/monitor.ts` | 完全重写：内联 WebSocket/Webhook 监听、事件分发、message recalled 处理 |
| `extensions/feishu/src/monitor.utils.ts` | 新文件：撤回事件摘要提取工具函数 |
| `extensions/feishu/src/bot.ts` | `parseFeishuMessageEvent` 接收 `allBotOpenIds`；集成 `resolveQuotedFeishuMessageContent` |
| `extensions/feishu/src/bot-sender-name.ts` | 41050 错误 backoff；过期缓存定时清理 |
| `extensions/feishu/src/typing.ts` | `addTypingIndicator` 缺少 `reaction_id` 时的 list-reaction fallback |
| `extensions/feishu/src/channel.ts` | message sending/sent hooks 集成；action 生命周期重构 |
| `extensions/feishu/src/config-schema.ts` | 新增 `dispatchMode`、`streamingInThread`、`pluginMode`、`cardHeader`/`cardNote` 配置 |
| `extensions/feishu/index.ts` | 导出重构：直接导入替代 `loadBundledEntryExportSync`；暴露 `createFeishuReplyDispatcher` |
| `extensions/feishu/src/monitor.account.ts` | multi-account bot identity prefetch |
| `extensions/feishu/src/monitor.events.test.ts` | 撤回事件测试 |
| `extensions/feishu/src/bot.test.ts` | 全面扩展：quoted message、multi-bot mention、DM open policy 测试 |
| `extensions/feishu/src/quoted-message.test.ts` | 4 层引用消息解析测试 |
| `extensions/feishu/src/typing.reaction-id-fallback.test.ts` | typing reaction fallback 测试 |

## 伪代码 (Pseudocode)

### 1. Mention 标签归一化 (`normalizeMentionTagsForCard`)

```javascript
// 正则定义：匹配 <at user_id="xxx">Display</at> 格式
const AT_USER_ID_TAG_RE =
  /<at\s+user_id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>[\s\S]*?<\/at>/gi;

function normalizeMentionTagsForCard(content) {
  if (!content.includes("<at")) return content;  // 快速路径

  // 关键：使用正则全局替换（非逐个 replace）
  // 每个匹配独立转换，不存在级联替换风险
  return content.replace(AT_USER_ID_TAG_RE,
    (full, quotedDouble, quotedSingle, unquoted) => {
      const id = pickMentionId(quotedDouble, quotedSingle, unquoted);
      if (!id) return full;
      return `<at id=${id}></at>`;  // 标准卡片格式
    }
  );
}

// 反方向：<at id=xxx></at> → <at user_id="xxx">DisplayName</at>
function normalizeMentionTagsForText(content, displayNameByOpenId) {
  return content.replace(AT_ID_TAG_RE,
    (full, quotedDouble, quotedSingle, unquoted) => {
      const id = pickMentionId(quotedDouble, quotedSingle, unquoted);
      if (!id) return full;
      const name = displayNameByOpenId?.[id] ?? (id === "all" ? "Everyone" : id);
      return `<at user_id="${id}">${name}</at>`;
    }
  );
}
```

### 2. 四层引用消息解析 (`resolveQuotedFeishuMessageContent`)

```javascript
async function resolveQuotedFeishuMessageContent(params) {
  const { cfg, sessionKey, chatId, parentId, isGroup, accountId } = params;
  if (!parentId) return {};

  // === 非群聊时，优先从本地查找（避免 API 调用）===

  if (!isGroup) {
    // 层1: Live session transcript（内存中的当前对话记录）
    const liveContent = readQuotedContentFromLiveSession({
      storePath, sessionKey, parentId, accountId, chatId,
    });
    if (liveContent) return { content: liveContent, source: "session" };

    // 层2: Disk session transcript（JSONL 文件）
    const diskContent = readQuotedContentFromSession({
      storePath, agentId, sessionKey, parentId, accountId, chatId,
    });
    if (diskContent) return { content: diskContent, source: "session" };

    // 层3: Bot Company DB（SQLite 历史消息库）
    const dbContent = readQuotedContentFromBotCompanyDb({
      cfg, chatId, parentId,
    });
    if (dbContent) return { content: dbContent, source: "db" };
  }

  // 层4: 飞书 API（兜底，适用于所有场景）
  const apiResult = await fetchMessage({ cfg, messageId: parentId, accountId });
  return apiResult?.content
    ? { content: apiResult.content, source: "api" }
    : {};
}

// 在 session transcript 中匹配引用消息的核心逻辑：
function findQuotedContentInEntries(entries, params) {
  // 从后向前遍历（最新的消息优先）
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    const role = entry.message.role?.toLowerCase();

    if (role === "user") {
      // 用户消息：从 "Conversation info" JSON 块中提取 message_id 比对
      const convInfo = extractConversationInfo(entry.message.text);
      if (convInfo?.message_id === params.parentId) {
        return stripEnvelopeFromMessage(entry.message);
      }
    }

    if (role === "assistant") {
      // 助手消息：从 openclawMessageMeta 中匹配 providerMessageId
      const meta = entry.message.openclawMessageMeta;
      if (matchesMirroredAssistantMessage({ meta, parentId, accountId, chatId })) {
        return stripEnvelopeFromMessage(entry.message);
      }
    }
  }
  return undefined;
}
```

### 3. 消息撤回处理 (`buildRecalledEventSummary`)

```javascript
function buildRecalledEventSummary(eventData) {
  const event = eventData ?? {};
  const message = asRecord(event.message);

  return {
    messageId: event.message_id ?? message?.message_id ?? "unknown",
    chatId: event.chat_id ?? message?.chat_id ?? "unknown",
    // 操作者：尝试多个字段（operator_id → deleter_id → user_id）
    operatorOpenId: resolveOpenIdLike(event.operator_id)
      ?? resolveOpenIdLike(event.deleter_id)
      ?? resolveOpenIdLike(event.user_id)
      ?? "unknown",
    senderOpenId: resolveOpenIdLike(message?.sender_id) ?? "unknown",
    rootId: message?.root_id ?? "unknown",
    threadId: message?.thread_id ?? "unknown",
    recallTime: event.recall_time ?? event.action_time ?? "unknown",
  };
}

// 在 monitor 的事件注册中使用：
eventDispatcher.register({
  "im.message.recalled_v1": async (data) => {
    const summary = buildRecalledEventSummary(data);
    log(`feishu[${accountId}]: message recalled ` +
      `chat=${summary.chatId} message=${summary.messageId} ` +
      `operator=${summary.operatorOpenId}`);
  },
});
```

### 4. 发送者名称 41050 Backoff (`resolveFeishuSenderName`)

```javascript
const SENDER_NAME_NOAUTH_BACKOFF_MS = 10 * 60 * 1000;  // 10 分钟
const senderLookupBackoff = new Map();  // key → backoffUntil timestamp

async function resolveFeishuSenderName(params) {
  const { account, senderId } = params;
  const lookupKey = `${account.appId}:${senderId}`;

  // 检查 backoff 状态
  const backoffUntil = senderLookupBackoff.get(lookupKey) ?? 0;
  if (backoffUntil > Date.now()) {
    return {};  // 静默跳过，不发请求
  }

  try {
    const res = await client.contact.user.get({ user_id: senderId });
    const name = res.data?.user?.name;
    if (name) {
      senderLookupBackoff.delete(lookupKey);  // 成功则清除 backoff
      senderNameCache.set(senderId, { name, expireAt: now + TTL });
      return { name };
    }
    return {};
  } catch (err) {
    // 41050 = "no user authority" → 进入 backoff
    if (isNoUserAuthorityError(err)) {
      senderLookupBackoff.set(lookupKey, Date.now() + SENDER_NAME_NOAUTH_BACKOFF_MS);
      log(`feishu: backing off sender lookup for ${senderId}`);
      return {};
    }
    // 其他错误：权限提示等原有逻辑
    throw err;
  }
}

// 定时清理过期条目（每小时）
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of senderNameCache) {
    if (entry.expireAt < now) senderNameCache.delete(key);
  }
  for (const [key, until] of senderLookupBackoff) {
    if (until < now) senderLookupBackoff.delete(key);
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();
```

### 5. Typing Reaction Fallback (`addTypingIndicator`)

```javascript
async function addTypingIndicator(params) {
  const { messageId, accountId, botOpenId } = params;

  const response = await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: "Typing" } },
  });

  const directReactionId = response.data?.reaction_id;
  if (directReactionId) {
    return { messageId, reactionId: directReactionId };
  }

  // SDK 某些版本不返回 reaction_id → list + match fallback
  const listResult = await client.im.messageReaction.list({
    path: { message_id: messageId },
    params: { reaction_type: "Typing" },
  });

  const fallbackId = pickTypingReactionIdForCleanup({
    items: listResult.data?.items,
    botOpenId,
  });

  return { messageId, reactionId: fallbackId ?? null };
}

function pickTypingReactionIdForCleanup(params) {
  let firstAppReactionId;
  let appReactionCount = 0;

  for (const item of params.items ?? []) {
    if (item.operator_type !== "app") continue;
    appReactionCount++;

    // 精确匹配：operator open_id === 当前 bot
    if (params.botOpenId && item.operator_id?.open_id === params.botOpenId) {
      return item.reaction_id;
    }

    if (!firstAppReactionId) firstAppReactionId = item.reaction_id;
  }

  // 无 botOpenId 时：只在唯一 app reaction 时安全清理
  if (!params.botOpenId) {
    return appReactionCount === 1 ? firstAppReactionId : undefined;
  }
  return undefined;
}
```

## 数据流程图 (Data Flow Diagram)

### 引用消息 4 层解析流

```
用户引用消息 (parent_id = "msg_xxx")
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  resolveQuotedFeishuMessageContent()                        │
│  extensions/feishu/src/quoted-message.ts:316                │
│                                                             │
│  isGroup?                                                   │
│  ├─ 否（DM）──→ 层1: Live Session Transcript (内存)        │
│  │                   │                                      │
│  │              找到? ──→ 返回 { content, source: "session" }│
│  │                   │                                      │
│  │              层2: Disk Session JSONL 文件                 │
│  │                   │                                      │
│  │              找到? ──→ 返回 { content, source: "session" }│
│  │                   │                                      │
│  │              层3: Bot Company DB (SQLite)                 │
│  │                   │                                      │
│  │              找到? ──→ 返回 { content, source: "db" }    │
│  │                   │                                      │
│  └─ 是（群聊）─┤    ▼                                      │
│                层4: 飞书 API getMessageFeishu()              │
│                     │                                       │
│                找到? ──→ 返回 { content, source: "api" }    │
│                     │                                       │
│                     └──→ 返回 {}                            │
└──────────────────────────────────────────────────────────────┘
```

### Mention 标签处理流

```
飞书入站消息:
  "Hello <at user_id="ou_abc">Alice</at> and <at user_id="ou_def">Bob</at>"
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  parseFeishuMessageEvent()                                  │
│  extensions/feishu/src/bot.ts:142                           │
│                                                             │
│  allBotOpenIds = Set { "ou_bot1", "ou_bot2" }               │
│                                                             │
│  extractMentionTargets(event, botOpenId, allBotOpenIds)     │
│  ├─ ou_bot1 → 过滤（是 bot）                                │
│  ├─ ou_bot2 → 过滤（也是 bot）                              │
│  ├─ ou_abc  → 保留 { openId, name: "Alice", key: "@_user_1" }│
│  └─ ou_def  → 保留 { openId, name: "Bob", key: "@_user_2" } │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  normalizeMentionTagsForCard()                              │
│  extensions/feishu/src/mention.ts:32                        │
│                                                             │
│  正则全局替换（非逐个 String.replace）                       │
│  <at user_id="ou_abc">Alice</at> → <at id=ou_abc></at>     │
│  <at user_id="ou_def">Bob</at>   → <at id=ou_def></at>     │
│                                                             │
│  无级联风险：每个匹配独立处理                                │
└──────────────────────────────────────────────────────────────┘
```

### Bot 发送者名称查询（含 backoff）

```
                  收到消息，需要解析 sender 名称
                           │
                           ▼
                  ┌─────────────────────┐
                  │ 缓存命中?           │
                  │ senderNameCache     │
                  └─────┬───────────────┘
                   是/  │  \否
                  /     │    \
                 ▼      │     ▼
           返回缓存     │  ┌───────────────────────┐
                        │  │ backoff 中?            │
                        │  │ senderLookupBackoff    │
                        │  └─────┬─────────────────┘
                        │   是/  │  \否
                        │  /     │    \
                        │ ▼      │     ▼
                        │返回{}  │  调用飞书 API
                        │        │     │
                        │        │     ├─ 成功 → 写入缓存，清除 backoff
                        │        │     │
                        │        │     ├─ 41050 错误 → 设置 10min backoff
                        │        │     │
                        │        │     └─ 其他错误 → 权限提示逻辑
                        │        │
                        │  ┌─────┴─────────────────────────┐
                        │  │ 定时清理 (每小时)              │
                        │  │ cleanupExpiredSenderEntries()  │
                        │  │ 清除过期缓存 + 过期 backoff    │
                        │  └───────────────────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `extensions/feishu/src/mention.ts` | 19-21 | `AT_USER_ID_TAG_RE` / `AT_ID_TAG_RE` 正则定义 |
| `extensions/feishu/src/mention.ts` | 32-43 | `normalizeMentionTagsForCard()`: user_id 格式 → id 格式归一化 |
| `extensions/feishu/src/mention.ts` | 45-60 | `normalizeMentionTagsForText()`: id 格式 → user_id 格式（含显示名） |
| `extensions/feishu/src/mention.ts` | 65-78 | `buildBotOpenIdSet()`: 聚合所有已知 bot open_id |
| `extensions/feishu/src/mention.ts` | 83-100 | `extractMentionTargets()`: 排除所有已知 bot 的 mention |
| `extensions/feishu/src/mention.ts` | 106-133 | `isMentionForwardRequest()`: 群聊需 mention bot + 至少一个人类用户 |
| `extensions/feishu/src/quoted-message.ts` | 18-23 | `ResolvedQuotedFeishuMessage` 类型：content + source |
| `extensions/feishu/src/quoted-message.ts` | 88-116 | `extractConversationInfo()`: 从 user message 提取 Conversation info JSON |
| `extensions/feishu/src/quoted-message.ts` | 155-202 | `findQuotedContentInEntries()`: 从 transcript 条目中匹配被引用消息 |
| `extensions/feishu/src/quoted-message.ts` | 204-235 | `readQuotedContentFromLiveSession()`: 层1 - 内存 session |
| `extensions/feishu/src/quoted-message.ts` | 237-277 | `readQuotedContentFromSession()`: 层2 - 磁盘 JSONL |
| `extensions/feishu/src/quoted-message.ts` | 295-315 | `readQuotedContentFromBotCompanyDb()`: 层3 - SQLite DB |
| `extensions/feishu/src/quoted-message.ts` | 316-410 | `resolveQuotedFeishuMessageContent()`: 4 层 fallback 编排 |
| `extensions/feishu/src/monitor.ts` | 43-55 | `FeishuReactionCreatedEvent` 类型定义 |
| `extensions/feishu/src/monitor.ts` | 180-215 | `resolveReactionSyntheticEvent()`: reaction → 合成消息事件 |
| `extensions/feishu/src/monitor.ts` | 233-365 | `registerEventHandlers()`: 统一事件注册（含 recalled、member added/deleted） |
| `extensions/feishu/src/monitor.ts` | 300-313 | `im.message.recalled_v1` 处理：调用 `buildRecalledEventSummary` + 日志 |
| `extensions/feishu/src/monitor.ts` | 430-500 | `monitorSingleAccount()`: 单账号监听入口 |
| `extensions/feishu/src/monitor.ts` | 520-570 | `monitorWebSocket()`: WebSocket 连接管理 |
| `extensions/feishu/src/monitor.ts` | 570-650 | `monitorWebhook()`: HTTP webhook 服务器 + rate limiting |
| `extensions/feishu/src/monitor.utils.ts` | 60-90 | `buildRecalledEventSummary()`: 撤回事件摘要提取 |
| `extensions/feishu/src/bot-sender-name.ts` | 28-30 | `SENDER_NAME_NOAUTH_BACKOFF_MS` 常量 + `senderLookupBackoff` Map |
| `extensions/feishu/src/bot-sender-name.ts` | 32-51 | `cleanupExpiredSenderEntries()`: 定时清理过期缓存/backoff |
| `extensions/feishu/src/bot-sender-name.ts` | 98-107 | `buildSenderLookupKey()`: appId + senderId 组合 key |
| `extensions/feishu/src/bot-sender-name.ts` | 109-121 | `isNoUserAuthorityError()`: 检测 41050 错误码 |
| `extensions/feishu/src/bot-sender-name.ts` | 146-151 | backoff 检查：`backoffUntil > now` 时直接跳过 |
| `extensions/feishu/src/bot-sender-name.ts` | 162-172 | 成功时清除 backoff，41050 时设置 backoff |
| `extensions/feishu/src/typing.ts` | 47-103 | `pickTypingReactionIdForCleanup()`: reaction list 中匹配 bot 的 reaction |
| `extensions/feishu/src/typing.ts` | 194-241 | `addTypingIndicator()` fallback：直接返回缺失 → list reaction → match |
| `extensions/feishu/src/config-schema.ts` | 23 | `DispatchModeSchema`: `"auto" | "plugin"` |
| `extensions/feishu/src/config-schema.ts` | 72-78 | `PluginModeConfigSchema`: `forwardControlCommands` |
| `extensions/feishu/src/config-schema.ts` | 187-191 | 新增 `pluginMode`、`streamingInThread`、`cardHeader`、`cardNote` 配置项 |
| `extensions/feishu/src/bot.ts` | 142-145 | `parseFeishuMessageEvent` 新增 `allBotOpenIds` 参数 |
| `extensions/feishu/src/channel.ts` | 443-509 | `emitFeishuActionMessageSent()` + `applyFeishuActionMessageSending()` hooks |
