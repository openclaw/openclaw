---
summary: "流式传输 + 分块行为（块回复、频道预览流式传输、模式映射）"
read_when:
  - 解释频道上的流式传输或分块如何工作
  - 更改块流式传输或频道分块行为
  - 调试重复/早期块回复或频道预览流式传输
title: "流式传输和分块"
---

# 流式传输 + 分块

OpenClaw 有两个独立的流式传输层：

- **块流式传输（频道）**：在助手写入时发出完成的**块**。这些是正常的频道消息（不是令牌增量）。
- **预览流式传输（Telegram/Discord/Slack）**：在生成时更新临时**预览消息**。

今天**没有真正的令牌增量流式传输**到频道消息。预览流式传输是基于消息的（发送 + 编辑/追加）。

## 块流式传输（频道消息）

块流式传输在助手输出可用时以粗粒度块发送。

```
模型输出
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ 分块器在缓冲区增长时发出块
       └─ (blockStreamingBreak=message_end)
            └─ 分块器在 message_end 时刷新
                   └─ 频道发送（块回复）
```

图例：

- `text_delta/events`：模型流事件（对于非流式模型可能稀疏）。
- `分块器`：`EmbeddedBlockChunker` 应用最小/最大边界 + 中断偏好。
- `频道发送`：实际的出站消息（块回复）。

**控制：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（默认关闭）。
- 频道覆盖：`*.blockStreaming`（和每个账户变体），以按频道强制设置 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（在发送前合并流式块）。
- 频道硬上限：`*.textChunkLimit`（例如，`channels.whatsapp.textChunkLimit`）。
- 频道分块模式：`*.chunkMode`（默认 `length`，`newline` 在长度分块之前在空行（段落边界）处拆分）。
- Discord 软上限：`channels.discord.maxLinesPerMessage`（默认 17）拆分高回复以避免 UI 裁剪。

**边界语义：**

- `text_end`：一旦分块器发出就流式传输块；在每个 `text_end` 时刷新。
- `message_end`：等待助手消息完成，然后刷新缓冲输出。

如果缓冲文本超过 `maxChars`，`message_end` 仍会使用分块器，因此它可以在末尾发出多个块。

## 分块算法（低/高边界）

块分块由 `EmbeddedBlockChunker` 实现：

- **低边界**：在缓冲区 >= `minChars` 之前不发出（除非强制）。
- **高边界**：偏好在 `maxChars` 之前拆分；如果强制，在 `maxChars` 处拆分。
- **中断偏好**：`paragraph` → `newline` → `sentence` → `whitespace` → 硬中断。
- **代码围栏**：永远不在围栏内拆分；当在 `maxChars` 处强制时，关闭 + 重新打开围栏以保持 Markdown 有效。

`maxChars` 被限制为频道 `textChunkLimit`，因此你不能超过每个频道的上限。

## 合并（合并流式块）

启用块流式传输时，OpenClaw 可以在发送前**合并连续的块分块**。这减少了“单行垃圾信息”，同时仍然提供渐进式输出。

- 合并在 **空闲间隙**（`idleMs`）等待后刷新。
- 缓冲区由 `maxChars` 限制，超过时会刷新。
- `minChars` 防止微小片段在足够文本累积之前发送（最终刷新始终发送剩余文本）。
- 连接器从 `blockStreamingChunk.breakPreference` 派生
  （`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格）。
- 频道覆盖可通过 `*.blockStreamingCoalesce` 获得（包括每个账户配置）。
- 对于 Signal/Slack/Discord，默认合并 `minChars` 提高到 1500，除非覆盖。

## 块之间的类人节奏

启用块流式传输时，你可以在**块回复之间添加随机暂停**（第一个块之后）。这使多气泡响应感觉更自然。

- 配置：`agents.defaults.humanDelay`（通过 `agents.list[].humanDelay` 按代理覆盖）。
- 模式：`off`（默认），`natural`（800–2500ms），`custom`（`minMs`/`maxMs`）。
- 仅适用于**块回复**，不适用于最终回复或工具摘要。

## "流式分块或全部"

这映射到：

- **流式分块**：`blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（边走边发）。非 Telegram 频道还需要 `*.blockStreaming: true`。
- **最后流式传输所有内容**：`blockStreamingBreak: "message_end"`（刷新一次，如果很长可能多个分块）。
- **无块流式传输**：`blockStreamingDefault: "off"`（仅最终回复）。

**频道注意：** 块流式传输**默认关闭**，除非
`*.blockStreaming` 明确设置为 `true`。频道可以流式传输实时预览
（`channels.<channel>.streaming`）而不需要块回复。

配置位置提醒：`blockStreaming*` 默认值位于
`agents.defaults` 下，而不是根配置。

## 预览流式传输模式

规范键：`channels.<channel>.streaming`

模式：

- `off`：禁用预览流式传输。
- `partial`：单个预览，被最新文本替换。
- `block`：预览以分块/追加步骤更新。
- `progress`：生成期间的进度/状态预览，完成时最终答案。

### 频道映射

| 频道     | `off` | `partial` | `block` | `progress`        |
| -------- | ----- | --------- | ------- | ----------------- |
| Telegram | ✅    | ✅        | ✅      | 映射到 `partial` |
| Discord  | ✅    | ✅        | ✅      | 映射到 `partial` |
| Slack    | ✅    | ✅        | ✅      | ✅                |

仅 Slack：

- `channels.slack.streaming.nativeTransport` 在 `channels.slack.streaming.mode="partial"` 时切换 Slack 原生流式传输 API 调用（默认：`true`）。
- Slack 原生流式传输和 Slack 助手线程状态需要回复线程目标；顶级 DM 不显示那种线程式预览。

旧键迁移：

- Telegram：`streamMode` + 布尔 `streaming` 自动迁移到 `streaming` 枚举。
- Discord：`streamMode` + 布尔 `streaming` 自动迁移到 `streaming` 枚举。
- Slack：`streamMode` 自动迁移到 `streaming.mode`；布尔 `streaming` 自动迁移到 `streaming.mode` 加 `streaming.nativeTransport`；旧 `nativeStreaming` 自动迁移到 `streaming.nativeTransport`。

### 运行时行为

Telegram：

- 使用 `sendMessage` + `editMessageText` 预览更新，跨 DM 和群组/主题。
- 当 Telegram 块流式传输明确启用时，预览流式传输被跳过（以避免双重流式传输）。
- `/reasoning stream` 可以将推理写入预览。

Discord：

- 使用发送 + 编辑预览消息。
- `block` 模式使用草稿分块（`draftChunk`）。
- 当 Discord 块流式传输明确启用时，预览流式传输被跳过。

Slack：

- `partial` 可以在可用时使用 Slack 原生流式传输（`chat.startStream`/`append`/`stop`）。
- `block` 使用追加式草稿预览。
- `progress` 使用状态预览文本，然后是最终答案。

## 相关

- [消息](/concepts/messages) — 消息生命周期和传递
- [重试](/concepts/retry) — 传递失败时的重试行为
- [频道](/channels) — 每个频道的流式传输支持