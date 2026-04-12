# Patch 08: 飞书出站消息钩子、媒体发送与渠道绑定增强

## 为什么要改 (Why)

### 问题 1: 出站消息缺少 `message_sending` / `message_sent` 钩子元数据

飞书出站适配器（outbound）发送消息后，返回的结果只有 `messageId` 和 `chatId`，没有携带内容类型（`contentType`）、原始消息体（`rawContent`）等元数据。下游消费者（如 journal 系统、消息审计）无法区分消息是文本、卡片还是媒体，也无法获取飞书 API 返回的实际 image_key / file_key。

### 问题 2: 图片/文件回复行为不一致

`sendImageFeishu` 和 `sendFileFeishu` 在 `replyToMessageId` 存在时，无论 `replyInThread` 是否为 true 都使用 `message.reply` API。这导致非话题线程的图片回复（`replyInThread=false`）仍然以 reply 方式发送，而正确行为应该是使用 `message.create`（直接发送到聊天）。

### 问题 3: 媒体类型定义分散在多处

`resolveMediaContentType` 函数和扩展名常量散落在不同文件中，没有统一的媒体类型定义。outbound 适配器需要在发送结果中附加正确的 `contentType`（image/video/audio/file），缺少集中化的类型解析。

### 问题 4: `toFeishuSendResult` 丢失 API 返回的真实 `chat_id`

当通过 DM（open_id）发送消息时，调用方传入的 `chatId` 实际是用户的 `open_id`，但飞书 API 返回的 `data.chat_id` 是真正的 `oc_*` 会话 ID。旧逻辑总是使用调用方传入的值，导致下游无法获取真实的会话 ID。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `extensions/feishu/src/media-types.ts` | 新文件。定义 `IMAGE_EXTENSIONS`、`VIDEO_EXTENSIONS`、`AUDIO_EXTENSIONS` 常量集合；导出 `resolveMediaContentType` 从文件扩展名或 URL 解析媒体类型 |
| `extensions/feishu/src/media.ts` | `SendMediaResult` 新增 `rawContent` 字段；`sendImageFeishu` 和 `sendFileFeishu` 修改回复条件为 `replyToMessageId && replyInThread`（仅话题线程时 reply）；返回值附带 `rawContent`（JSON 格式的 image_key/file_key） |
| `extensions/feishu/src/outbound.ts` | 引入 `resolveMediaContentType` 和 `shouldUseFeishuMarkdownCard`；新增 `attachFeishuMediaMetadata` 辅助函数；`sendText` 返回值附加 `meta: { contentType, finalContent }` 或 `meta: { contentType, rawContent }`；媒体发送失败的 fallback 不再暴露内部路径 |
| `extensions/feishu/src/outbound.test.ts` | 新增 80+ 行测试覆盖：验证 `meta.contentType` / `meta.rawContent` / `meta.finalContent` 在文本、卡片、媒体发送结果中的正确性 |
| `extensions/feishu/src/send-result.ts` | `FeishuMessageApiResponse.data` 新增 `chat_id` 字段；新增 `rethrowWithFeishuErrorDetail` 辅助函数；`toFeishuSendResult` 优先使用 API 返回的 `data.chat_id` |
| `extensions/feishu/src/send.ts` | 移除 `sanitizeFeishuTextForDelivery` 函数（指令标签剥离已在 Patch 07 上移到 dispatcher 层）；`sendMessageFeishu` / `editMessageFeishu` / `buildMarkdownCard` / `buildStructuredCard` 不再调用 `stripInlineDirectiveTagsForDelivery` |
| `extensions/feishu/src/send.test.ts` | 移除 96 行旧版指令标签剥离测试（逻辑已迁移） |
| `extensions/feishu/src/send.reply-fallback.test.ts` | 补充 `replyInThread: true` 参数以适配新的回复条件 |
| `extensions/feishu/src/media.test.ts` | 更新 mp4/image 回复测试：验证非 `replyInThread` 时使用 `message.create` 而非 `message.reply` |

## 伪代码 (Pseudocode)

### 1. 媒体类型解析

```javascript
// media-types.ts — 集中化的媒体类型定义
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi"])
const AUDIO_EXTENSIONS = new Set([".opus", ".ogg", ".mp3", ".wav"])

function resolveMediaContentType(extOrUrl) {
  // 支持传入纯扩展名（".png"）或完整 URL/路径
  const ext = extOrUrl.startsWith(".")
    ? extOrUrl.toLowerCase()
    : path.extname(extOrUrl).toLowerCase()

  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (VIDEO_EXTENSIONS.has(ext)) return "video"
  if (AUDIO_EXTENSIONS.has(ext)) return "audio"
  return "file"
}
```

### 2. 出站消息元数据增强

```javascript
// outbound.ts — 为发送结果附加元数据
function attachFeishuMediaMetadata(sent, mediaUrl) {
  const contentType = resolveMediaContentType(mediaUrl)
  return {
    ...sent,
    meta: {
      ...(sent.meta ?? {}),
      contentType,                           // "image" / "video" / "audio" / "file"
      rawContent: sent.rawContent ?? `[${contentType}: ${mediaUrl}]`,
    },
  }
}

// sendText 回调中的元数据附加
async sendText({ cfg, to, text, ... }) {
  const useCard = renderMode === "card" || shouldUseFeishuMarkdownCard(text)
  if (useCard) {
    const sent = await sendStructuredCardFeishu({ ... })
    return {
      ...sent,
      meta: { contentType: "interactive", finalContent: normalizeMentionTagsForCard(text) },
    }
  }
  const sent = await sendOutboundText({ ... })
  return {
    ...sent,
    meta: { contentType: "post", finalContent: text },
  }
}

// sendMedia 回调中的元数据附加
async sendMedia({ cfg, to, mediaUrl, ... }) {
  const sent = await sendMediaFeishu({ ... })
  return attachFeishuMediaMetadata(sent, mediaUrl)  // 自动解析 contentType
}
```

### 3. 图片发送回复条件修复

```javascript
// media.ts — 仅在话题线程时使用 reply API
async function sendImageFeishu({ replyToMessageId, replyInThread, ... }) {
  const imageKey = await uploadImage(...)
  const content = JSON.stringify({ image_key: imageKey })

  // 修复：旧逻辑只检查 replyToMessageId，新逻辑要求两者都为 true
  if (replyToMessageId && replyInThread) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: "image", reply_in_thread: true },
    })
    return { ...toFeishuSendResult(response, receiveId), rawContent: content }
  }

  // 非话题线程：使用 message.create 直接发送
  const response = await client.im.message.create({
    data: { receive_id: receiveId, content, msg_type: "image" },
  })
  return { ...toFeishuSendResult(response, receiveId), rawContent: content }
}
```

### 4. `toFeishuSendResult` 优先使用 API 返回的 chat_id

```javascript
// send-result.ts
function toFeishuSendResult(response, chatId) {
  return {
    messageId: response.data?.message_id ?? "unknown",
    // 优先使用 API 返回的真实 chat_id（oc_* 格式）
    // DM 场景：调用方传入 open_id，但 API 返回真实会话 ID
    chatId: response.data?.chat_id ?? chatId,
  }
}
```

## 数据流程图 (Data Flow Diagram)

### 出站消息发送与元数据附加

```
┌──────────────────────────┐
│  Channel Outbound        │
│  Adapter                 │
│  (outbound.ts)           │
└───────────┬──────────────┘
            │
     ┌──────┴──────────────────────────┐
     │                                 │
     ▼                                 ▼
┌────────────┐                ┌────────────────┐
│ sendText() │                │ sendMedia()    │
└─────┬──────┘                └────────┬───────┘
      │                                │
      │ renderMode判断                 │
      ▼                                ▼
┌─────────────────┐          ┌──────────────────┐
│ card模式:       │          │ sendMediaFeishu() │
│ sendStructured  │          │  - uploadImage()  │
│ CardFeishu()    │          │  - message.create │
│                 │          │    或 .reply      │
│ text模式:       │          │  (取决于          │
│ sendMessage     │          │   replyInThread)  │
│ Feishu()        │          └────────┬─────────┘
└────────┬────────┘                   │
         │                            │
         ▼                            ▼
┌──────────────────────┐    ┌──────────────────────┐
│ 附加 meta:           │    │ attachFeishuMedia    │
│ {                    │    │ Metadata():          │
│   contentType:       │    │ {                    │
│     "interactive"    │    │   contentType:       │
│     / "post",        │    │     "image" / "video"│
│   finalContent: text │    │     / "audio",       │
│ }                    │    │   rawContent:        │
└──────────┬───────────┘    │     '{"image_key":…}'│
           │                │ }                    │
           │                └──────────┬───────────┘
           │                           │
           └────────┬──────────────────┘
                    ▼
┌──────────────────────────────────┐
│  发送结果                        │
│  {                               │
│    messageId: "om_xxx",          │
│    chatId: "oc_xxx",  ← API返回 │
│    meta: { contentType, ... }    │
│  }                               │
└──────────────────────────────────┘
```

### 图片回复路由修正

```
sendImageFeishu(replyToMessageId, replyInThread)
           │
           ├── replyToMessageId && replyInThread === true
           │       │
           │       ▼
           │   client.im.message.reply()  ← 话题线程回复
           │   data: { reply_in_thread: true }
           │
           └── 其他情况（无 replyTo 或 replyInThread=false）
                   │
                   ▼
               client.im.message.create()  ← 直接发送
               params: { receive_id: ... }
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `extensions/feishu/src/media-types.ts` | 1-29 | 完整文件：`IMAGE_EXTENSIONS`/`VIDEO_EXTENSIONS`/`AUDIO_EXTENSIONS` 常量与 `resolveMediaContentType` 函数 |
| `extensions/feishu/src/media.ts` | 313-314 | `SendMediaResult` 新增 `rawContent` 可选字段 |
| `extensions/feishu/src/media.ts` | 420 | `sendImageFeishu` 修改条件为 `replyToMessageId && replyInThread` |
| `extensions/feishu/src/media.ts` | 430 | `sendImageFeishu` reply 路径返回 `rawContent: content` |
| `extensions/feishu/src/media.ts` | 442 | `sendImageFeishu` create 路径返回 `rawContent: content` |
| `extensions/feishu/src/media.ts` | 467 | `sendFileFeishu` 同步修改条件为 `replyToMessageId && replyInThread` |
| `extensions/feishu/src/media.ts` | 477 | `sendFileFeishu` reply 路径返回 `rawContent: content` |
| `extensions/feishu/src/media.ts` | 489 | `sendFileFeishu` create 路径返回 `rawContent: content` |
| `extensions/feishu/src/outbound.ts` | 8 | 新增 `resolveMediaContentType` 导入 |
| `extensions/feishu/src/outbound.ts` | 111-125 | `attachFeishuMediaMetadata` 辅助函数 |
| `extensions/feishu/src/outbound.ts` | 164 | `sendText` 中 local image auto-convert 路径附加元数据 |
| `extensions/feishu/src/outbound.ts` | 194-212 | `sendText` card 模式附加 `meta: { contentType: "interactive", finalContent }` |
| `extensions/feishu/src/outbound.ts` | 213-222 | `sendText` text 模式附加 `meta: { contentType: "post", finalContent }` |
| `extensions/feishu/src/outbound.ts` | 273 | `sendMedia` 成功路径调用 `attachFeishuMediaMetadata` |
| `extensions/feishu/src/outbound.ts` | 277-280 | `sendMedia` 失败 fallback 不再暴露内部路径（`isLocalPath` 判断） |
| `extensions/feishu/src/send-result.ts` | 6 | `FeishuMessageApiResponse.data` 新增 `chat_id` 字段 |
| `extensions/feishu/src/send-result.ts` | 19-24 | 新增 `rethrowWithFeishuErrorDetail` 错误增强函数 |
| `extensions/feishu/src/send-result.ts` | 33-37 | `toFeishuSendResult` 优先使用 `response.data?.chat_id` |
| `extensions/feishu/src/send.ts` | 577 | `sendMessageFeishu` 移除 `sanitizeFeishuTextForDelivery` 调用 |
| `extensions/feishu/src/send.ts` | 730 | `buildMarkdownCard` 移除 `sanitizeFeishuTextForDelivery` 调用 |
| `extensions/feishu/src/send.ts` | 777 | `buildStructuredCard` 移除 `sanitizeFeishuTextForDelivery` 调用 |
