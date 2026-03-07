---
read_when:
  - 解释入站消息如何转化为回复
  - 阐明会话、队列模式或流式传输行为
  - 记录推理可见性和使用影响
summary: 消息流程、会话、队列和推理可见性
title: 消息
x-i18n:
  generated_at: "2026-02-03T10:05:22Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 147362b61bee21ee6e303654d970a052325f076ddb45814306053f70409737b5
  source_path: concepts/messages.md
  workflow: 15
---

# 消息

本页汇总了 OpenClaw 如何处理入站消息、会话、队列、流式传输和推理可见性。

## 消息流程（高层概述）

```
入站消息
  -> 路由/绑定 -> 会话密钥
  -> 队列（如果有运行中的任务）
  -> 智能体运行（流式传输 + 工具）
  -> 出站回复（渠道限制 + 分块）
```

关键配置项在配置中：

- `messages.*` 用于前缀、队列和群组行为。
- `agents.defaults.*` 用于分块流式传输和分块默认值。
- 渠道覆盖（`channels.whatsapp.*`、`channels.telegram.*` 等）用于上限和流式传输开关。

完整 schema 参见[配置](/gateway/configuration)。

## 入站去重

渠道可能在重新连接后重复投递同一消息。OpenClaw 保持一个短期缓存，以渠道/账户/对端/会话/消息 ID 为键，因此重复投递不会触发另一次智能体运行。

## 入站防抖

来自**同一发送者**的快速连续消息可以通过 `messages.inbound` 批量合并为单个智能体轮次。防抖按渠道 + 会话为范围，并使用最近的消息进行回复线程/ID 处理。

配置（全局默认 + 单渠道覆盖）：

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

注意事项：

- 防抖仅适用于**纯文本**消息；媒体/附件会立即刷新。
- 控制命令会绕过防抖，保持独立。

## 会话和设备

会话由 Gateway 网关拥有，而非客户端。

- 直接聊天合并到智能体主会话密钥。
- 群组/渠道获得各自的会话密钥。
- 会话存储和记录保存在 Gateway 网关主机上。

多个设备/渠道可以映射到同一会话，但历史记录不会完全同步回每个客户端。建议：对长对话使用一个主设备，以避免上下文分歧。控制 UI 和 TUI 始终显示 Gateway 网关支持的会话记录，因此它们是事实来源。

详情：[会话管理](/concepts/session)。

## 入站正文和历史上下文

OpenClaw 将**提示正文**与**命令正文**分开：

- `Body`：发送给智能体的提示文本。这可能包括渠道信封和可选的历史包装器。
- `CommandBody`：用于指令/命令解析的原始用户文本。
- `RawBody`：`CommandBody` 的旧别名（为兼容性保留）。

当渠道提供历史记录时，使用共享包装器：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

对于**非直接聊天**（群组/渠道/房间），**当前消息正文**会加上发送者标签前缀（与历史条目使用的样式相同）。这使智能体提示中的实时消息和队列/历史消息保持一致。

历史缓冲区是**仅待处理的**：它们包含*未*触发运行的群组消息（例如，提及门控的消息），并**排除**已在会话记录中的消息。

指令剥离仅适用于**当前消息**部分，因此历史记录保持完整。包装历史记录的渠道应将 `CommandBody`（或 `RawBody`）设置为原始消息文本，并将 `Body` 保留为组合提示。历史缓冲区可通过 `messages.groupChat.historyLimit`（全局默认）和单渠道覆盖（如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`）进行配置（设置 `0` 表示禁用）。

## 队列和后续消息

如果运行已在进行中，入站消息可以排队、导入当前运行，或收集用于后续轮次。

- 通过 `messages.queue`（和 `messages.queue.byChannel`）配置。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及积压变体。

详情：[队列](/concepts/queue)。

## 流式传输、分块和批处理

分块流式传输在模型生成文本块时发送部分回复。分块遵循渠道文本限制，避免拆分围栏代码。

关键设置：

- `agents.defaults.blockStreamingDefault`（`on|off`，默认 off）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基于空闲的批处理）
- `agents.defaults.humanDelay`（块回复之间的拟人化暂停）
- 渠道覆盖：`*.blockStreaming` 和 `*.blockStreamingCoalesce`（非 Telegram 渠道需要显式设置 `*.blockStreaming: true`）

详情：[流式传输 + 分块](/concepts/streaming)。

## 推理可见性和 token

OpenClaw 可以显示或隐藏模型推理：

- `/reasoning on|off|stream` 控制可见性。
- 当模型产生推理内容时，它仍计入 token 使用量。
- Telegram 支持将推理流式传输到草稿气泡中。

详情：[思考 + 推理指令](/tools/thinking)和 [Token 使用](/reference/token-use)。

## 前缀、线程和回复

出站消息格式在 `messages` 中集中配置：

- `messages.responsePrefix`（出站前缀）和 `channels.whatsapp.messagePrefix`（WhatsApp 入站前缀）
- 通过 `replyToMode` 和单渠道默认值进行回复线程

详情：[配置](/gateway/configuration#messages)和渠道文档。
