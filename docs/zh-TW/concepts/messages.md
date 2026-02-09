---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - 說明傳入訊息如何轉換為回覆
  - Clarifying sessions, queueing modes, or streaming behavior
  - 文件化推理可見性與使用上的影響
title: "訊息"
---

# 訊息

This page ties together how OpenClaw handles inbound messages, sessions, queueing,
streaming, and reasoning visibility.

## 訊息流程（高階）

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

主要調整旋鈕位於設定中：

- `messages.*` 用於前綴、佇列與群組行為。
- `agents.defaults.*` 用於區塊串流與分塊的預設值。
- 頻道覆寫（`channels.whatsapp.*`、`channels.telegram.*` 等）用於上限與串流切換。 for caps and streaming toggles.

完整結構請參閱 [設定](/gateway/configuration)。

## 傳入去重（Inbound dedupe）

Channels can redeliver the same message after reconnects. 頻道在重新連線後可能重新投遞相同的訊息。OpenClaw 會維持一個短存活快取，以 頻道 / 帳號 / 對象 / 工作階段 / 訊息 ID 作為鍵，確保重複投遞不會再次觸發代理程式執行。

## 傳入防抖（Inbound debouncing）

Rapid consecutive messages from the **same sender** can be batched into a single
agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

設定（全域預設 + 每頻道覆寫）：

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

注意事項：

- Debounce applies to **text-only** messages; media/attachments flush immediately.
- 控制指令會略過防抖，以保持其獨立性。

## Sessions and devices

Sessions are owned by the gateway, not by clients.

- Direct chats collapse into the agent main session key.
- 群組／頻道各自擁有獨立的工作階段鍵。
- The session store and transcripts live on the gateway host.

Multiple devices/channels can map to the same session, but history is not fully
synced back to every client. Recommendation: use one primary device for long
conversations to avoid divergent context. The Control UI and TUI always show the
gateway-backed session transcript, so they are the source of truth.

詳情：[工作階段管理](/concepts/session)。

## Inbound bodies and history context

OpenClaw separates the **prompt body** from the **command body**:

- `Body`: prompt text sent to the agent. This may include channel envelopes and
  optional history wrappers.
- `CommandBody`：用於指令／命令解析的原始使用者文字。
- `RawBody`：`CommandBody` 的舊別名（為相容性保留）。

當頻道提供歷史時，會使用共用的包裝格式：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the
sender label (same style used for history entries). This keeps real-time and queued/history
messages consistent in the agent prompt.

History buffers are **pending-only**: they include group messages that did _not_
trigger a run (for example, mention-gated messages) and **exclude** messages
already in the session transcript.

Directive stripping only applies to the **current message** section so history
remains intact. Channels that wrap history should set `CommandBody` (or
`RawBody`) to the original message text and keep `Body` as the combined prompt.
History buffers are configurable via `messages.groupChat.historyLimit` (global
default) and per-channel overrides like `channels.slack.historyLimit` or
`channels.telegram.accounts.<id>.historyLimit`）進行設定（將 `0` 設為停用）。

## Queueing and followups

If a run is already active, inbound messages can be queued, steered into the
current run, or collected for a followup turn.

- 透過 `messages.queue`（以及 `messages.queue.byChannel`）設定。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及其 backlog 變體。

詳情：[佇列](/concepts/queue)。

## Streaming, chunking, and batching

Block streaming sends partial replies as the model produces text blocks.1) 分塊會遵守通道文字長度限制，並避免切分圍欄程式碼。

主要設定：

- `agents.defaults.blockStreamingDefault`（`on|off`，預設關閉）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基於閒置的批次）
- `agents.defaults.humanDelay`（區塊回覆之間的類人暫停）
- 頻道覆寫：`*.blockStreaming` 與 `*.blockStreamingCoalesce`（非 Telegram 頻道需要明確設定 `*.blockStreaming: true`）

詳情：[串流 + 分塊](/concepts/streaming)。

## 2. 推理可見性與權杖

OpenClaw 可顯示或隱藏模型推理：

- `/reasoning on|off|stream` 控制可見性。
- 3. 由模型產生的推理內容仍會計入權杖用量。
- Telegram 支援將推理串流至草稿氣泡。

詳情：[思考 + 推理指令](/tools/thinking) 與 [權杖使用](/reference/token-use)。

## 前綴、串接與回覆

傳出訊息的格式化集中於 `messages`：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 與 `channels.<channel>.accounts.<id>.responsePrefix`（傳出前綴級聯），以及 `channels.whatsapp.messagePrefix`（WhatsApp 傳入前綴）
- 透過 `replyToMode` 與每頻道預設值進行回覆串接

詳情：[設定](/gateway/configuration#messages) 與各頻道文件。
