---
read_when:
  - 解释入站消息如何变为回复
  - 澄清会话、队列模式或流式传输行为
  - 记录推理可见性和用量影响
summary: 消息流、会话、队列和推理可见性
title: 消息
x-i18n:
  generated_at: "2026-02-01T20:22:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 147362b61bee21ee6e303654d970a052325f076ddb45814306053f70409737b5
  source_path: concepts/messages.md
  workflow: 14
---

# 消息

本页汇总了 OpenClaw 处理入站消息、会话、队列、流式传输和推理可见性的方式。

## 消息流（概览）

```
入站消息
  -> 路由/绑定 -> 会话键
  -> 队列（如果有运行中的任务）
  -> 智能体运行（流式传输 + 工具）
  -> 出站回复（渠道限制 + 分块）
```

关键配置项位于配置文件中：

- `messages.*` 用于前缀、队列和群组行为。
- `agents.defaults.*` 用于块流式传输和分块默认值。
- 渠道覆盖（`channels.whatsapp.*`、`channels.telegram.*` 等）用于上限和流式传输开关。

完整配置结构请参见[配置](/gateway/configuration)。

## 入站去重

渠道在重新连接后可能会重新投递相同的消息。OpenClaw 维护一个短期缓存，以渠道/账号/对端/会话/消息 ID 为键，避免重复投递触发额外的智能体运行。

## 入站防抖

来自**同一发送者**的快速连续消息可以通过 `messages.inbound` 合并为单个智能体轮次。防抖按渠道 + 对话维度隔离，并使用最新消息进行回复线程/ID 关联。

配置（全局默认 + 按渠道覆盖）：

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

说明：

- 防抖仅适用于**纯文本**消息；媒体/附件会立即发送。
- 控制命令会绕过防抖，保持为独立消息。

## 会话与设备

会话由 Gateway网关管理，而非由客户端管理。

- 私聊消息归并到智能体的主会话键。
- 群组/频道拥有各自独立的会话键。
- 会话存储和对话记录保存在 Gateway网关主机上。

多个设备/渠道可以映射到同一个会话，但历史记录不会完全同步回每个客户端。建议：长对话使用一个主要设备，以避免上下文分歧。控制界面和 TUI 始终显示 Gateway网关端的会话记录，因此它们是权威数据源。

详情请参见：[会话管理](/concepts/session)。

## 入站消息体和历史上下文

OpenClaw 将**提示词体**与**命令体**分开处理：

- `Body`：发送给智能体的提示词文本。可能包含渠道信封和可选的历史包装。
- `CommandBody`：用于指令/命令解析的原始用户文本。
- `RawBody`：`CommandBody` 的旧版别名（保留以兼容）。

当渠道提供历史记录时，使用共享的包装格式：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

对于**非私聊**（群组/频道/房间），**当前消息体**会添加发送者标签前缀（与历史条目使用相同的格式）。这使得实时消息和排队/历史消息在智能体提示词中保持一致。

历史缓冲区为**仅待处理消息**：它们包含未触发运行的群组消息（例如，提及门控的消息），并**排除**已在会话记录中的消息。

指令剥离仅适用于**当前消息**部分，历史记录保持不变。包装历史记录的渠道应将 `CommandBody`（或 `RawBody`）设置为原始消息文本，并将 `Body` 保留为组合提示词。历史缓冲区可通过 `messages.groupChat.historyLimit`（全局默认）和按渠道覆盖进行配置，例如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`（设置为 `0` 可禁用）。

## 队列与后续消息

如果已有运行中的任务，入站消息可以排队、引导至当前运行，或收集用于后续轮次。

- 通过 `messages.queue`（及 `messages.queue.byChannel`）进行配置。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及 backlog 变体。

详情请参见：[队列](/concepts/queue)。

## 流式传输、分块与批处理

块流式传输在模型生成文本块时发送部分回复。分块遵循渠道文本限制，避免拆分代码围栏。

关键设置：

- `agents.defaults.blockStreamingDefault`（`on|off`，默认 off）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基于空闲的批处理）
- `agents.defaults.humanDelay`（块回复之间的仿人类停顿）
- 渠道覆盖：`*.blockStreaming` 和 `*.blockStreamingCoalesce`（非 Telegram 渠道需要显式设置 `*.blockStreaming: true`）

详情请参见：[流式传输 + 分块](/concepts/streaming)。

## 推理可见性与令牌

OpenClaw 可以显示或隐藏模型推理过程：

- `/reasoning on|off|stream` 控制可见性。
- 推理内容在模型生成时仍然计入令牌用量。
- Telegram 支持将推理过程流式传输到草稿气泡中。

详情请参见：[思考 + 推理指令](/tools/thinking) 和 [令牌用量](/token-use)。

## 前缀、线程与回复

出站消息格式集中在 `messages` 中管理：

- `messages.responsePrefix`（出站前缀）和 `channels.whatsapp.messagePrefix`（WhatsApp 入站前缀）
- 通过 `replyToMode` 和按渠道默认值进行回复线程关联

详情请参见：[配置](/gateway/configuration#messages) 和各渠道文档。
