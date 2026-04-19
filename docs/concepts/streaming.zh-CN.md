---
summary: "流式传输 + 分块行为（块回复、通道预览流式传输、模式映射）"
read_when:
  - 解释通道上的流式传输或分块如何工作
  - 更改块流式传输或通道分块行为
  - 调试重复/早期块回复或通道预览流式传输
---

# 流式传输 + 分块

OpenClaw 有两个独立的流式传输层：

- **块流式传输（通道）**：在助手写入时发出完成的**块**。这些是普通的通道消息（不是令牌增量）。
- **预览流式传输（Telegram/Discord/Slack）**：在生成时更新临时**预览消息**。

目前**没有真正的令牌增量流式传输**到通道消息。预览流式传输是基于消息的（发送 + 编辑/追加）。

## 块流式传输（通道消息）

块流式传输在助手输出可用时以粗块形式发送。

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

- `text_delta/events`：模型流事件（对于非流式模型可能稀疏）。
- `chunker`：`EmbeddedBlockChunker` 应用最小/最大边界 + 中断偏好。
- `channel send`：实际的出站消息（块回复）。

**控制：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（默认关闭）。
- 通道覆盖：`*.blockStreaming`（和每个账户变体）强制每个通道的 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（在发送前合并流式块）。
- 通道硬上限：`*.textChunkLimit`（例如，`channels.whatsapp.textChunkLimit`）。
- 通道分块模式：`*.chunkMode`（`length` 默认，`newline` 在长度分块前按空行（段落边界）分割）。
- Discord 软上限：`channels.discord.maxLinesPerMessage`（默认 17）分割高回复以避免 UI 剪辑。

**边界语义：**

- `text_end`：一旦 chunker 发出就流式传输块；在每个 `text_end` 上刷新。
- `message_end`：等待直到助手消息完成，然后刷新缓冲的输出。

`message_end` 如果缓冲文本超过 `maxChars` 仍会使用 chunker，因此它可以在结束时发出多个块。

## 分块算法（低/高边界）

块分块由 `EmbeddedBlockChunker` 实现：

- **低边界：** 直到缓冲区 >= `minChars` 才发出（除非强制）。
- **高边界：** 更喜欢在 `maxChars` 之前分割；如果强制，在 `maxChars` 处分割。
- **中断偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 硬中断。
- **代码围栏：** 永远不在围栏内分割；当在 `maxChars` 处强制时，关闭 + 重新打开围栏以保持 Markdown 有效。

`maxChars` 被限制为通道 `textChunkLimit`，因此你不能超过每个通道的上限。

## 合并（合并流式块）

当启用块流式传输时，OpenClaw 可以在发送之前**合并连续的块分块**。这减少了“单行垃圾邮件”，同时仍然提供渐进式输出。

- 合并等待**空闲间隙**（`idleMs`）后再刷新。
- 缓冲区由 `maxChars` 限制，如果超过则会刷新。
- `minChars` 防止微小片段发送，直到累积足够的文本
  （最终刷新总是发送剩余文本）。
- 连接符派生自 `blockStreamingChunk.breakPreference`
  （`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格）。
- 通道覆盖可通过 `*.blockStreamingCoalesce` 获得（包括每个账户配置）。
- 默认合并 `minChars` 对于 Signal/Slack/Discord 提高到 1500，除非被覆盖。

## 块之间的类人节奏

当启用块流式传输时，你可以在块回复之间添加**随机化暂停**（在第一个块之后）。这使得多气泡响应感觉更自然。

- 配置：`agents.defaults.humanDelay`（通过 `agents.list[].humanDelay` 覆盖每个代理）。
- 模式：`off`（默认），`natural`（800–2500ms），`custom`（`minMs`/`maxMs`）。
- 仅适用于**块回复**，不适用于最终回复或工具摘要。

## "流式传输块或全部"

这映射到：

- **流式传输块：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（边走边发）。非 Telegram 通道还需要 `*.blockStreaming: true`。
- **最后流式传输全部：** `blockStreamingBreak: "message_end"`（刷新一次，如果很长可能多个块）。
- **无块流式传输：** `blockStreamingDefault: "off"`（仅最终回复）。

**通道注意：** 块流式传输**默认关闭**，除非
`*.blockStreaming` 明确设置为 `true`。通道可以流式传输实时预览
（`channels.<channel>.streaming`）而没有块回复。

配置位置提醒：`blockStreaming*` 默认值位于
`agents.defaults` 下，而不是根配置。

## 预览流式传输模式

规范键：`channels.<channel>.streaming`

模式：

- `off`：禁用预览流式传输。
- `partial`：单个预览，被最新文本替换。
- `block`：预览以分块/追加步骤更新。
- `progress`：生成期间的进度/状态预览，完成时的最终答案。

### 通道映射

| 通道     | `off` | `partial` | `block` | `progress`       |
| -------- | ----- | --------- | ------- | ---------------- |
| Telegram | ✅    | ✅        | ✅      | 映射到 `partial` |
| Discord  | ✅    | ✅        | ✅      | 映射到 `partial` |
| Slack    | ✅    | ✅        | ✅      | ✅               |

Slack 专用：

- `channels.slack.streaming.nativeTransport` 当 `channels.slack.streaming.mode="partial"` 时切换 Slack 原生流式传输 API 调用（默认：`true`）。
- Slack 原生流式传输和 Slack 助手线程状态需要回复线程目标；顶级 DM 不显示该线程样式预览。

遗留键迁移：

- Telegram：`streamMode` + 布尔值 `streaming` 自动迁移到 `streaming` 枚举。
- Discord：`streamMode` + 布尔值 `streaming` 自动迁移到 `streaming` 枚举。
- Slack：`streamMode` 自动迁移到 `streaming.mode`；布尔值 `streaming` 自动迁移到 `streaming.mode` 加 `streaming.nativeTransport`；遗留 `nativeStreaming` 自动迁移到 `streaming.nativeTransport`。

### 运行时行为

Telegram：

- 使用 `sendMessage` + `editMessageText` 预览更新，跨 DM 和组/主题。
- 当明确启用 Telegram 块流式传输时，跳过预览流式传输（以避免双重流式传输）。
- `/reasoning stream` 可以将推理写入预览。

Discord：

- 使用发送 + 编辑预览消息。
- `block` 模式使用草稿分块（`draftChunk`）。
- 当明确启用 Discord 块流式传输时，跳过预览流式传输。

Slack：

- `partial` 可以在可用时使用 Slack 原生流式传输（`chat.startStream`/`append`/`stop`）。
- `block` 使用追加式草稿预览。
- `progress` 使用状态预览文本，然后是最终答案。

## 相关

- [消息](/concepts/messages) — 消息生命周期和传递
- [重试](/concepts/retry) — 传递失败时的重试行为
- [通道](/channels) — 每个通道的流式传输支持
