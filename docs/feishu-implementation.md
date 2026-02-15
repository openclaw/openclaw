---
summary: "飞书（Feishu/Lark）渠道的代码改动梳理（开发者向），重点覆盖多媒体链路"
read_when:
  - 你需要了解飞书渠道在代码里的实现位置与集成点
  - 你想排查飞书收发消息/媒体上传下载的问题
  - 你准备扩展飞书的媒体能力（图片/音频/文件/视频）
---

# 飞书渠道：代码改动梳理（含多媒体）

这份文档面向开发者，按“集成点 → 入站 → 出站 → 多媒体”把飞书支持涉及到的代码改动与关键行为串起来。

---

## 代码落点（新增/核心实现）

- **核心实现目录**：`src/feishu/*`
  - **连接与事件接收**：`src/feishu/monitor.ts`
  - **事件结构与内容解析**：`src/feishu/events.ts`
  - **入站分发到 agent 系统**：`src/feishu/message-dispatch.ts`
  - **媒体下载（入站）**：`src/feishu/download.ts`
  - **消息发送（出站，含媒体上传）**：`src/feishu/send.ts`
  - **HTTP API 客户端（含上传/下载）**：`src/feishu/client.ts`
  - **账号解析/合并配置**：`src/feishu/accounts.ts`
  - **凭据解析**：`src/feishu/token.ts`

- **渠道 dock（将飞书加入 core 渠道列表/元信息）**：`src/channels/registry.ts`
  - `CHAT_CHANNEL_ORDER` 包含 `feishu`
  - `CHAT_CHANNEL_META.feishu.docsPath` 为 `/channels/feishu`（对应 `docs/channels/feishu.md`）

- **插件入口（channel plugin）**：`extensions/feishu/*`
  - 注册：`extensions/feishu/index.ts`
  - 实现：`extensions/feishu/src/channel.ts`

- **配置校验（Zod）**：
  - `src/config/zod-schema.providers-core.ts`: `FeishuConfigSchema`
  - `src/config/zod-schema.providers.ts`: `ChannelsSchema.feishu`

---

## 网关侧：事件接收方式（WebSocket 长连接）

- **接收模式**：飞书事件订阅使用 **WebSocket 长连接**（Lark SDK `WSClient`）
  - 代码：`src/feishu/monitor.ts`
  - 监听事件：`im.message.receive_v1`
  - 事件分发：`Lark.EventDispatcher().register({ "im.message.receive_v1": ... })`

这意味着飞书渠道不依赖公网回调 URL；只要网关进程在线即可接收消息。

---

## 入站：消息处理与路由（重点：媒体下载）

入站主流程在 `src/feishu/monitor.ts`（事件接收）与 `src/feishu/message-dispatch.ts`（分发到 agent 系统）。

### 支持的入站 message_type

代码中将以下类型纳入“会处理”的集合：

- `text`
- `image`
- `file`
- `audio`
- `media`（飞书的“视频”消息类型）
- `sticker`

> 注意：`sticker` 目前会被识别为“支持的类型”，但媒体下载逻辑明确跳过 sticker，因此若 sticker 没有可用文本，最终会被当作“空消息”忽略（见下文“已知限制/不一致点”）。

### 访问控制/群组策略（与飞书支持相关的改动点）

入站阶段会做多层 gate（主要在 `src/feishu/message-dispatch.ts`）：

- **群组启用开关**：`channels.feishu.groups.<chat_id>.enabled`
- **群组 requireMention**：群聊是否要求 @（走通用 group-policy 解析）
- **DM 策略**：`dmPolicy` 支持 `pairing / allowlist / open / disabled`
  - 当前实现里 `pairing` 仍是“预留模式”（未知 DM 暂不自动发配对码）

### 媒体下载（关键改动）

当消息类型为 `image/file/audio/media(video)` 时，会尝试下载并落盘：

- 入口：`src/feishu/download.ts` 的 `downloadFeishuInboundMedia()`
- 下载 API：`src/feishu/client.ts` 的 `getMessageResource()`
  - `image` → `type="image"`，使用 `content.image_key`
  - `file` → `type="file"`，使用 `content.file_key`
  - `audio` → `type="audio"`，使用 `content.file_key`
  - `media`（视频）→ `type="video"`，使用 `content.file_key`
- 落盘：`saveMediaBuffer(..., "inbound", ...)`（路径为 `~/.openclaw/media/inbound/`）
- **媒体-only 触发**：若原消息没有文本，会用占位符触发 agent（例如 `<media:image>`），并写入 `MediaPath/MediaType`

入站 `maxBytes` 来自飞书配置（优先 account-level）：

- `maxMediaBytes = (account.config.mediaMaxMb ?? channels.feishu.mediaMaxMb ?? 20) * 1024 * 1024`

### 入站上下文如何“带媒体”

入站会把媒体信息映射到通用上下文字段（与 Telegram 类似）：

- `MediaPath`: `media?.path`
- `MediaType`: `media?.contentType`
- `MediaUrl`: `media?.path`（这里复用 path）

---

## 出站：发送文本/媒体（重点：媒体上传）

飞书出站主要由两层串起来：

- channel plugin：`extensions/feishu/src/channel.ts`
- 具体 API 调用：`src/feishu/send.ts` / `src/feishu/client.ts`

### `sendMessageFeishu()` / `sendMediaFeishu()` 的关键行为

`src/feishu/send.ts`：

- **出站媒体**：`sendMediaFeishu()` 支持 `image/audio/video/file`
  - **图片**：默认发 `image`（预览）；若 `channels.feishu.imageDoubleSend=true`，再补发一条 `file`（图片双写发送）
  - **音频**：OPUS/OGG 优先发 `audio`；否则按 `file`
  - **视频**：mp4 优先发 `media`；否则按 `file`
  - **文件**：按 `file`
- **Markdown 渲染**：`sendMessageFeishu({ autoRichText: true })` 会发送 `interactive`（卡片），以获得更完整的 markdown 兼容（列表/代码块/表格/HR 等）

### 出站文本分块（与配置的关系）

通用出站层（`src/infra/outbound/deliver.ts`）支持按 `textChunkLimit/chunkMode` 做分块，但这要求 channel outbound adapter 提供 `chunker`。

- 当前 `extensions/feishu/src/channel.ts` 的 outbound 配置里 `chunker: null`，因此通用出站层不会对飞书出站文本自动分块。
- 如果你看到飞书能“分段发送”，那通常来自更上游的 reply/payload 生成阶段（而不是 outbound deliver 对 feishu 的 chunker）。

---

## 多媒体支持：能力清单与关键细节

### 入站（用户 → 网关）

- **支持类型（会尝试处理）**：`text / image / file / audio / media(video) / sticker`
- **实际会下载落盘的类型**：`image / file / audio / media(video)`
  - API：`FeishuClient.getMessageResource()`
  - 保存：`saveMediaBuffer(..., "inbound", ...)`
  - 大小限制：`channels.feishu.mediaMaxMb`（默认 20MB）

### 出站（网关 → 飞书）

- **入口**：`sendMediaFeishu(...)`（由 `extensions/feishu/src/channel.ts` 或 `src/feishu/message-dispatch.ts` 调用）
- **媒体来源**：`loadWebMedia()` 支持 `http(s)://` 与本地路径（含 `file://` 与 `~`）
- **图片优化**：出站加载时会对图片进行优化/压缩尝试（见 `src/web/media.ts`）
- **飞书音频限制**：飞书原生 `audio` 只支持 opus；非 opus 会按“文件附件”发送
- **错误处理策略**：媒体上传/发送失败会抛错，不会静默降级成纯文本（便于排障）

### 配置项与代码对应关系（媒体相关）

- `channels.feishu.mediaMaxMb`
  - **入站**：用于限制 `FeishuClient.getMessageResource()` 下载大小（已在代码中生效）
  - **出站**：用于限制 `loadWebMedia(mediaUrl, maxBytes)` 的抓取/处理上限（已在代码中生效）

- `channels.feishu.imageDoubleSend`
  - **出站**：图片发送是否启用“双写”（`image` + `file`）

---

## 插件/扩展层：为什么既有 core 代码又有 `extensions/feishu`

飞书渠道在仓库里同时存在：

- **core 实现（`src/feishu/*`）**：负责真正的 SDK 调用、收发消息、媒体下载/上传等“重逻辑”
- **extension 包（`extensions/feishu/*`）**：把飞书作为一个 channel plugin 注册进插件系统
  - `extensions/feishu/index.ts`：`api.registerChannel({ plugin: feishuPlugin })`
  - `extensions/feishu/src/channel.ts`：声明 capabilities（`media: true`）、onboarding/status/gateway start 等

另外，插件系统配置默认会把 bundled 的 `feishu` 设为 enabled（见 `src/plugins/config-state.ts`），所以多数情况下无需用户额外开启插件才可用飞书渠道。

---

## CLI 辅助命令（与飞书支持相关的增量）

飞书新增了一个调试子命令：`openclaw-cn feishu ...`

- 注册入口：`src/cli/program/register.subclis.ts`
- 实现：`src/commands/feishu.ts`
  - `openclaw-cn feishu probe`：验证 appId/appSecret 是否可拿 token、可读 bot info
  - `openclaw-cn feishu send`：发送测试文本到指定 `chat_id`
  - `openclaw-cn feishu accounts`：列出已配置账户

---

## 已知限制 / 不一致点（来自当前代码行为）

- **sticker 入站**：
  - 当前未实现 sticker 下载；若消息无文本也无可下载资源，会被忽略
  - 如果希望 sticker 也能触发（例如用占位符 `<media:sticker>`），需要扩展 `src/feishu/message-dispatch.ts` / `src/feishu/download.ts` 的策略

- **出站媒体大小限制**：
  - 入站/出站均使用 `channels.feishu.mediaMaxMb` 控制最大体积（入站下载、出站抓取/处理）
