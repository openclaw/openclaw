---
summary: "消息流、会话、排队和推理可见性"
read_when:
  - 解释入站消息如何成为回复
  - 澄清会话、排队模式或流式传输行为
  - 记录推理可见性和使用影响
---

# 消息

本页面将 OpenClaw 如何处理入站消息、会话、排队、流式传输和推理可见性联系在一起。

## 消息流（高级）

```
入站消息
  -> 路由/绑定 -> 会话键
  -> 队列（如果运行活跃）
  -> 代理运行（流式传输 + 工具）
  -> 出站回复（通道限制 + 分块）
```

关键旋钮位于配置中：

- `messages.*` 用于前缀、排队和群组行为。
- `agents.defaults.*` 用于块流式传输和分块默认值。
- 通道覆盖（`channels.whatsapp.*`、`channels.telegram.*` 等）用于上限和流式传输切换。

请参阅 [配置](/gateway/configuration) 了解完整架构。

## 入站去重

通道可以在重新连接后重新传递相同的消息。OpenClaw 保持一个短期缓存，按通道/账户/对等方/会话/消息 ID 键控，因此重复传递不会触发另一个代理运行。

## 入站去抖动

来自**同一发送者**的快速连续消息可以通过 `messages.inbound` 批处理到单个代理轮次。去抖动作用域为每个通道 + 对话，并使用最新消息进行回复线程/ID。

配置（全局默认值 + 每个通道覆盖）：

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

- 去抖动适用于**纯文本**消息；媒体/附件立即刷新。
- 控制命令绕过去抖动，因此它们保持独立。

## 会话和设备

会话由网关拥有，而不是客户端。

- 直接聊天折叠到代理主会话键。
- 群组/通道获得自己的会话键。
- 会话存储和记录位于网关主机上。

多个设备/通道可以映射到同一个会话，但历史记录不会完全同步回每个客户端。建议：使用一个主设备进行长对话，以避免上下文分歧。控制 UI 和 TUI 始终显示网关支持的会话记录，因此它们是事实来源。

详细信息：[会话管理](/concepts/session)。

## 入站正文和历史上下文

OpenClaw 将**提示正文**与**命令正文**分开：

- `Body`：发送给代理的提示文本。这可能包括通道信封和可选的历史包装器。
- `CommandBody`：用于指令/命令解析的原始用户文本。
- `RawBody`：`CommandBody` 的遗留别名（为了兼容性保留）。

当通道提供历史记录时，它使用共享包装器：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

对于**非直接聊天**（群组/通道/房间），**当前消息正文**以发送者标签为前缀（与历史条目的样式相同）。这使代理提示中的实时和排队/历史消息保持一致。

历史缓冲区是**仅待处理**的：它们包括未触发运行的群组消息（例如，提及门控消息），并**排除**已在会话记录中的消息。

指令剥离仅适用于**当前消息**部分，因此历史记录保持完整。包装历史记录的通道应将 `CommandBody`（或 `RawBody`）设置为原始消息文本，并将 `Body` 保持为组合提示。历史缓冲区可通过 `messages.groupChat.historyLimit`（全局默认值）和每个通道覆盖（如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`）配置（设置 `0` 禁用）。

## 排队和跟进

如果运行已经活跃，入站消息可以排队、引导到当前运行或收集用于后续轮次。

- 通过 `messages.queue`（和 `messages.queue.byChannel`）配置。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及积压变体。

详细信息：[排队](/concepts/queue)。

## 流式传输、分块和批处理

块流式传输在模型生成文本块时发送部分回复。分块尊重通道文本限制，避免拆分带围栏的代码。

关键设置：

- `agents.defaults.blockStreamingDefault`（`on|off`，默认关闭）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基于空闲的批处理）
- `agents.defaults.humanDelay`（块回复之间的类人暂停）
- 通道覆盖：`*.blockStreaming` 和 `*.blockStreamingCoalesce`（非 Telegram 通道需要显式 `*.blockStreaming: true`）

详细信息：[流式传输 + 分块](/concepts/streaming)。

## 推理可见性和令牌

OpenClaw 可以显示或隐藏模型推理：

- `/reasoning on|off|stream` 控制可见性。
- 当模型生成推理内容时，它仍然计入令牌使用。
- Telegram 支持将推理流到草稿气泡中。

详细信息：[思考 + 推理指令](/tools/thinking) 和 [令牌使用](/reference/token-use)。

## 前缀、线程和回复

出站消息格式在 `messages` 中集中：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 和 `channels.<channel>.accounts.<id>.responsePrefix`（出站前缀级联），以及 `channels.whatsapp.messagePrefix`（WhatsApp 入站前缀）
- 通过 `replyToMode` 和每个通道默认值进行回复线程

详细信息：[配置](/gateway/configuration-reference#messages) 和通道文档。

## 相关

- [流式传输](/concepts/streaming) — 实时消息传递
- [重试](/concepts/retry) — 消息传递重试行为
- [队列](/concepts/queue) — 消息处理队列
- [通道](/channels) — 消息平台集成
