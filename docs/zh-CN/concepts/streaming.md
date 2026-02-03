---
read_when:
  - 解释流式传输或分块在渠道上的工作方式
  - 更改块流式传输或渠道分块行为
  - 调试重复/提前的块回复或草稿流式传输问题
summary: 流式传输 + 分块行为（块回复、草稿流式传输、限制）
title: 流式传输与分块
x-i18n:
  generated_at: "2026-02-01T20:24:24Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f014eb1898c4351b1d6b812223226d91324701e3e809cd0f3faf6679841bc353
  source_path: concepts/streaming.md
  workflow: 14
---

# 流式传输 + 分块

OpenClaw 有两个独立的"流式传输"层：

- **块流式传输（渠道）：** 在助手生成内容时发送已完成的**块**。这些是普通的渠道消息（不是 token 增量）。
- **类 Token 流式传输（仅 Telegram）：** 在生成过程中用部分文本更新**草稿气泡**；最终消息在结束时发送。

目前**没有真正的 token 流式传输**到外部渠道消息。Telegram 草稿流式传输是唯一的部分流式传输界面。

## 块流式传输（渠道消息）

块流式传输在助手输出可用时以粗粒度块发送。

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

图例：

- `text_delta/events`：模型流事件（对于非流式模型可能较为稀疏）。
- `chunker`：`EmbeddedBlockChunker`，应用最小/最大边界 + 断点偏好。
- `channel send`：实际的出站消息（块回复）。

**控制项：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（默认关闭）。
- 渠道覆盖：`*.blockStreaming`（以及按账户的变体）可按渠道强制 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（发送前合并流式块）。
- 渠道硬性上限：`*.textChunkLimit`（例如 `channels.whatsapp.textChunkLimit`）。
- 渠道分块模式：`*.chunkMode`（默认 `length`，`newline` 在空行（段落边界）处分割，然后再按长度分块）。
- Discord 软性上限：`channels.discord.maxLinesPerMessage`（默认 17）拆分过长的回复以避免 UI 裁剪。

**边界语义：**

- `text_end`：分块器发出块后立即流式传输；在每个 `text_end` 时刷新。
- `message_end`：等待助手消息完成后，再刷新缓冲输出。

`message_end` 在缓冲文本超过 `maxChars` 时仍会使用分块器，因此可能在最后发出多个块。

## 分块算法（低/高边界）

块分块由 `EmbeddedBlockChunker` 实现：

- **低边界：** 在缓冲区 >= `minChars` 之前不发出（除非强制）。
- **高边界：** 优先在 `maxChars` 之前分割；如果强制，则在 `maxChars` 处分割。
- **断点偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 硬断点。
- **代码围栏：** 永远不在围栏内分割；当在 `maxChars` 处被强制分割时，关闭并重新打开围栏以保持 Markdown 有效。

`maxChars` 会被限制在渠道的 `textChunkLimit` 以内，因此不会超过按渠道的上限。

## 合并（合并流式块）

当块流式传输启用时，OpenClaw 可以在发送前**合并连续的块**。这减少了"单行刷屏"的情况，同时仍提供渐进式输出。

- 合并会等待**空闲间隔**（`idleMs`）后再刷新。
- 缓冲区受 `maxChars` 限制，超出时会刷新。
- `minChars` 防止在积累足够文本之前发送微小片段（最终刷新始终发送剩余文本）。
- 连接符由 `blockStreamingChunk.breakPreference` 派生（`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格）。
- 渠道覆盖可通过 `*.blockStreamingCoalesce` 设置（包括按账户的配置）。
- 除非覆盖，Signal/Slack/Discord 的默认合并 `minChars` 会提升至 1500。

## 块之间的仿真人节奏

当块流式传输启用时，你可以在块回复之间（第一个块之后）添加**随机停顿**。这让多气泡回复感觉更自然。

- 配置：`agents.defaults.humanDelay`（通过 `agents.list[].humanDelay` 按智能体覆盖）。
- 模式：`off`（默认）、`natural`（800–2500ms）、`custom`（`minMs`/`maxMs`）。
- 仅适用于**块回复**，不适用于最终回复或工具摘要。

## "流式发送块还是一次性发送全部"

对应关系：

- **流式发送块：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（边生成边发送）。非 Telegram 渠道还需要设置 `*.blockStreaming: true`。
- **结束时一次性发送：** `blockStreamingBreak: "message_end"`（刷新一次，如果内容很长可能产生多个块）。
- **不使用块流式传输：** `blockStreamingDefault: "off"`（仅最终回复）。

**渠道说明：** 对于非 Telegram 渠道，块流式传输**默认关闭**，除非 `*.blockStreaming` 显式设置为 `true`。Telegram 可以通过 `channels.telegram.streamMode` 进行草稿流式传输，无需块回复。

配置位置提醒：`blockStreaming*` 默认值位于 `agents.defaults` 下，而非根配置。

## Telegram 草稿流式传输（类 Token）

Telegram 是唯一支持草稿流式传输的渠道：

- 在**带话题的私聊**中使用 Bot API `sendMessageDraft`。
- `channels.telegram.streamMode: "partial" | "block" | "off"`。
  - `partial`：用最新的流式文本更新草稿。
  - `block`：以分块方式更新草稿（使用相同的分块器规则）。
  - `off`：不进行草稿流式传输。
- 草稿分块配置（仅用于 `streamMode: "block"`）：`channels.telegram.draftChunk`（默认值：`minChars: 200`，`maxChars: 800`）。
- 草稿流式传输与块流式传输是分离的；块回复默认关闭，仅在非 Telegram 渠道通过 `*.blockStreaming: true` 启用。
- 最终回复仍然是普通消息。
- `/reasoning stream` 将推理过程写入草稿气泡（仅 Telegram）。

当草稿流式传输处于活跃状态时，OpenClaw 会禁用该回复的块流式传输，以避免双重流式传输。

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

图例：

- `sendMessageDraft`：Telegram 草稿气泡（不是真正的消息）。
- `final reply`：普通的 Telegram 消息发送。
