---
read_when:
  - 解释流式传输或分块在渠道上如何工作
  - 更改分块流式传输或渠道分块行为
  - 调试重复/提前的块回复或草稿流式传输
summary: 流式传输 + 分块行为（块回复、草稿流式传输、限制）
title: 流式传输和分块
x-i18n:
  generated_at: "2026-02-03T10:05:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f014eb1898c4351b1d6b812223226d91324701e3e809cd0f3faf6679841bc353
  source_path: concepts/streaming.md
  workflow: 15
---

# 流式传输 + 分块

OpenClaw 有两个独立的"流式传输"层：

- **分块流式传输（渠道）：** 在助手写入时发出已完成的**块**。这些是普通的渠道消息（不是令牌增量）。
- **类令牌流式传输（仅限 Telegram）：** 在生成时用部分文本更新**草稿气泡**；最终消息在结束时发送。

目前**没有真正的令牌流式传输**到外部渠道消息。Telegram 草稿流式传输是唯一的部分流式传输界面。

## 分块流式传输（渠道消息）

分块流式传输在助手输出可用时以粗粒度块发送。

```
模型输出
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ 分块器在缓冲区增长时发出块
       └─ (blockStreamingBreak=message_end)
            └─ 分块器在 message_end 时刷新
                   └─ 渠道发送（块回复）
```

图例：

- `text_delta/events`：模型流事件（对于非流式模型可能稀疏）。
- `chunker`：应用最小/最大边界 + 断点偏好的 `EmbeddedBlockChunker`。
- `channel send`：实际的出站消息（块回复）。

**控制项：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（默认关闭）。
- 渠道覆盖：`*.blockStreaming`（以及每账户变体）可为每个渠道强制设置 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（发送前合并流式块）。
- 渠道硬上限：`*.textChunkLimit`（例如 `channels.whatsapp.textChunkLimit`）。
- 渠道分块模式：`*.chunkMode`（默认 `length`，`newline` 在长度分块之前按空行（段落边界）分割）。
- Discord 软上限：`channels.discord.maxLinesPerMessage`（默认 17）分割高度较大的回复以避免 UI 裁剪。

**边界语义：**

- `text_end`：分块器发出时立即流式传输块；在每个 `text_end` 时刷新。
- `message_end`：等到助手消息完成，然后刷新缓冲的输出。

如果缓冲文本超过 `maxChars`，`message_end` 仍然使用分块器，因此可能在最后发出多个块。

## 分块算法（低/高边界）

块分块由 `EmbeddedBlockChunker` 实现：

- **低边界：** 在缓冲区 >= `minChars` 之前不发出（除非强制）。
- **高边界：** 优先在 `maxChars` 之前分割；如果强制，则在 `maxChars` 处分割。
- **断点偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 硬断点。
- **代码围栏：** 从不在围栏内分割；当在 `maxChars` 处强制分割时，关闭 + 重新打开围栏以保持 Markdown 有效。

`maxChars` 被限制在渠道 `textChunkLimit` 内，因此你无法超过每渠道的上限。

## 合并（合并流式块）

启用分块流式传输时，OpenClaw 可以在发送前**合并连续的块分块**。这减少了"单行刷屏"，同时仍提供渐进式输出。

- 合并在**空闲间隙**（`idleMs`）后刷新。
- 缓冲区受 `maxChars` 限制，超过时将刷新。
- `minChars` 防止微小片段发送，直到累积足够文本（最终刷新始终发送剩余文本）。
- 连接符从 `blockStreamingChunk.breakPreference` 派生（`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格）。
- 渠道覆盖通过 `*.blockStreamingCoalesce` 可用（包括每账户配置）。
- 除非覆盖，Signal/Slack/Discord 的默认合并 `minChars` 提高到 1500。

## 块之间的类人节奏

启用分块流式传输时，你可以在块回复之间添加**随机暂停**（在第一个块之后）。这使多气泡响应感觉更自然。

- 配置：`agents.defaults.humanDelay`（通过 `agents.list[].humanDelay` 按智能体覆盖）。
- 模式：`off`（默认）、`natural`（800–2500ms）、`custom`（`minMs`/`maxMs`）。
- 仅适用于**块回复**，不适用于最终回复或工具摘要。

## "流式传输块或全部内容"

这映射到：

- **流式传输块：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（边生成边发出）。非 Telegram 渠道还需要 `*.blockStreaming: true`。
- **最后流式传输全部内容：** `blockStreamingBreak: "message_end"`（刷新一次，如果很长可能有多个块）。
- **无分块流式传输：** `blockStreamingDefault: "off"`（只有最终回复）。

**渠道说明：** 对于非 Telegram 渠道，分块流式传输**默认关闭**，除非 `*.blockStreaming` 明确设置为 `true`。Telegram 可以在没有块回复的情况下流式传输草稿（`channels.telegram.streamMode`）。

配置位置提醒：`blockStreaming*` 默认值位于 `agents.defaults` 下，而不是根配置。

## Telegram 草稿流式传输（类令牌）

Telegram 是唯一支持草稿流式传输的渠道：

- 在**带主题的私聊**中使用 Bot API `sendMessageDraft`。
- `channels.telegram.streamMode: "partial" | "block" | "off"`。
  - `partial`：用最新的流式文本更新草稿。
  - `block`：以分块方式更新草稿（相同的分块器规则）。
  - `off`：无草稿流式传输。
- 草稿分块配置（仅用于 `streamMode: "block"`）：`channels.telegram.draftChunk`（默认值：`minChars: 200`，`maxChars: 800`）。
- 草稿流式传输与分块流式传输分开；块回复默认关闭，仅在非 Telegram 渠道上通过 `*.blockStreaming: true` 启用。
- 最终回复仍然是普通消息。
- `/reasoning stream` 将推理写入草稿气泡（仅限 Telegram）。

当草稿流式传输活跃时，OpenClaw 会为该回复禁用分块流式传输以避免双重流式传输。

```
Telegram（私聊 + 主题）
  └─ sendMessageDraft（草稿气泡）
       ├─ streamMode=partial → 更新最新文本
       └─ streamMode=block   → 分块器更新草稿
  └─ 最终回复 → 普通消息
```

图例：

- `sendMessageDraft`：Telegram 草稿气泡（不是真正的消息）。
- `final reply`：普通 Telegram 消息发送。
