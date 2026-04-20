---
summary: "消息流、会话、队列和推理可见性"
read_when:
  - 解释入站消息如何成为回复
  - 澄清会话、队列模式或流式传输行为
  - 记录推理可见性和使用影响
title: "消息"
---

# 消息

本页面将 OpenClaw 如何处理入站消息、会话、队列、流式传输和推理可见性联系在一起。

## 消息流（高级）

```
入站消息
  -> 路由/绑定 -> 会话键
  -> 队列（如果运行活跃）
  -> 代理运行（流式传输 + 工具）
  -> 出站回复（频道限制 + 分块）
```

关键旋钮在配置中：

- `messages.*` 用于前缀、队列和群组行为。
- `agents.defaults.*` 用于块流式传输和分块默认值。
- 频道覆盖（`channels.whatsapp.*`、`channels.telegram.*` 等）用于上限和流式传输切换。

请参阅 [配置](/gateway/configuration) 获取完整架构。

## 入站去重

频道可以在重新连接后重新传递相同的消息。OpenClaw 保持一个由频道/账户/对等方/会话/消息 ID 键控的短期缓存，因此重复传递不会触发另一个代理运行。

## 入站防抖

来自**同一发送者**的快速连续消息可以通过 `messages.inbound` 批处理到单个代理回合中。防抖按频道 + 对话范围，并使用最新消息进行回复线程/ID。

配置（全局默认值 + 每个频道覆盖）：

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

注意：

- 防抖适用于**纯文本**消息；媒体/附件立即刷新。
- 控制命令绕过防抖，因此它们保持独立。

## 会话和设备

会话由网关拥有，而不是由客户端拥有。

- 直接聊天折叠到代理主会话键中。
- 群组/频道获得自己的会话键。
- 会话存储和记录位于网关主机上。

多个设备/频道可以映射到同一个会话，但历史不会完全同步回每个客户端。建议：使用一个主要设备进行长对话，以避免上下文分歧。控制 UI 和 TUI 始终显示网关支持的会话记录，因此它们是真实来源。

详情：[会话管理](/concepts/session)。

## 入站正文和历史上下文

OpenClaw 将**提示正文**与**命令正文**分开：

- `Body`：发送给代理的提示文本。这可能包括频道信封和可选的历史包装器。
- `CommandBody`：用于指令/命令解析的原始用户文本。
- `RawBody`：`CommandBody` 的旧别名（为兼容性保留）。

当频道提供历史时，它使用共享包装器：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

对于**非直接聊天**（群组/频道/房间），**当前消息正文**前缀有发送者标签（与历史条目的样式相同）。这使得实时和排队/历史消息在代理提示中保持一致。

历史缓冲区是**仅待处理**的：它们包括**未**触发运行的群组消息（例如，提及门控消息），并**排除**已在会话记录中的消息。

指令剥离仅适用于**当前消息**部分，因此历史保持完整。包装历史的频道应将 `CommandBody`（或 `RawBody`）设置为原始消息文本，并将 `Body` 保持为组合提示。历史缓冲区可通过 `messages.groupChat.historyLimit`（全局默认值）和每个频道覆盖（如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`）配置（设置 `0` 禁用）。

## 排队和跟进

如果运行已经活跃，入站消息可以排队、引导到当前运行或收集用于后续回合。

- 通过 `messages.queue`（和 `messages.queue.byChannel`）配置。
- 模式：`interrupt`、`steer`、`followup`、`collect`，加上积压变体。

详情：[队列](/concepts/queue)。

## 流式传输、分块和批处理

块流式传输在模型产生文本块时发送部分回复。分块尊重频道文本限制并避免分割带围栏的代码。

关键设置：

- `agents.defaults.blockStreamingDefault`（`on|off`，默认关闭）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基于空闲的批处理）
- `agents.defaults.humanDelay`（块回复之间的类人暂停）
- 频道覆盖：`*.blockStreaming` 和 `*.blockStreamingCoalesce`（非 Telegram 频道需要显式 `*.blockStreaming: true`）

详情：[流式传输 + 分块](/concepts/streaming)。

## 推理可见性和令牌

OpenClaw 可以暴露或隐藏模型推理：

- `/reasoning on|off|stream` 控制可见性。
- 当由模型产生时，推理内容仍然计入令牌使用。
- Telegram 支持将推理流到草稿气泡中。

详情：[思考 + 推理指令](/tools/thinking) 和 [令牌使用](/reference/token-use)。

## 前缀、线程和回复

出站消息格式在 `messages` 中集中：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 和 `channels.<channel>.accounts.<id>.responsePrefix`（出站前缀级联），加上 `channels.whatsapp.messagePrefix`（WhatsApp 入站前缀）
- 通过 `replyToMode` 和每个频道默认值的回复线程

详情：[配置](/gateway/configuration-reference#messages) 和频道文档。

## 相关

- [流式传输](/concepts/streaming) — 实时消息传递
- [重试](/concepts/retry) — 消息传递重试行为
- [队列](/concepts/queue) — 消息处理队列
- [频道](/channels) — 消息平台集成
