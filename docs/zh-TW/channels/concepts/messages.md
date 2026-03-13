---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - Explaining how inbound messages become replies
  - "Clarifying sessions, queueing modes, or streaming behavior"
  - Documenting reasoning visibility and usage implications
title: Messages
---

# Messages

這個頁面將說明 OpenClaw 如何處理進來的訊息、會話、佇列、串流以及推理可見性。

## 訊息流程（高層次）

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

關鍵旋鈕位於設定中：

- `messages.*` 用於前綴、排隊和群組行為。
- `agents.defaults.*` 用於區塊串流和分塊預設值。
- 頻道覆蓋 (`channels.whatsapp.*`, `channels.telegram.*`, 等等) 用於能力和串流切換。

請參閱 [Configuration](/gateway/configuration) 以獲取完整的架構。

## Inbound dedupe

Channels 可以在重新連接後重新傳送相同的訊息。OpenClaw 保持一個短期快取，該快取以 channel/account/peer/session/message id 為鍵，這樣重複的傳送不會觸發另一個代理執行。

## Inbound debouncing

來自 **相同發送者** 的快速連續訊息可以透過 `messages.inbound` 批次處理成單一代理回應。去彈跳的範圍是針對每個頻道 + 對話，並使用最新的訊息進行回覆串接/ID。

Config (全域預設 + 每個頻道的覆蓋設定):

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

[[BLOCK_1]]

- 去彈性僅適用於 **純文字** 訊息；媒體/附件會立即發送。
- 控制指令會繞過去彈性，因此它們保持獨立。

## Sessions and devices

會話是由網關擁有，而不是由用戶端擁有。

- 直接聊天會合併到代理的主要會話金鑰中。
- 群組/頻道會擁有自己的會話金鑰。
- 會話存儲和記錄檔會保存在網關主機上。

多個裝置/通道可以映射到同一個會話，但歷史紀錄並不會完全同步回每個用戶端。建議：在進行長時間對話時使用一個主要裝置，以避免上下文的分歧。控制介面和 TUI 始終顯示由網關支援的會話記錄，因此它們是事實的來源。

細節：[會話管理](/concepts/session)。

## Inbound bodies and history context

OpenClaw 將 **prompt body** 與 **command body** 分開：

- `Body`: 發送給代理的提示文字。這可能包括通道信封和可選的歷史包裝。
- `CommandBody`: 用於指令/命令解析的原始用戶文字。
- `RawBody`: `CommandBody` 的舊版別名（為了相容性保留）。

當一個頻道提供歷史記錄時，它使用一個共享的包裝器：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

對於 **非直接聊天**（群組/頻道/房間），**當前訊息內容** 會以發送者標籤作為前綴（與歷史條目使用的樣式相同）。這樣可以保持即時訊息和排隊/歷史訊息在代理提示中的一致性。

歷史緩衝區是**僅限待處理**的：它們包含未觸發執行的群組訊息（例如，提及限制的訊息），並**排除**已在會話記錄中的訊息。

指令剝離僅適用於 **當前訊息** 區段，因此歷史紀錄保持不變。包裹歷史的頻道應將 `CommandBody` (或 `RawBody`) 設定為原始訊息文本，並保持 `Body` 為合併的提示。歷史緩衝區可以透過 `messages.groupChat.historyLimit` (全域預設) 和每個頻道的覆寫如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit` 進行設定 (設置 `0` 以禁用)。

## 排隊與後續跟進

如果一個執行已經在進行中，則可以將傳入的訊息排隊、引導到當前的執行中，或收集以便在後續回合中使用。

- 透過 `messages.queue` (和 `messages.queue.byChannel`) 進行設定。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及待辦變體。

細節: [排隊](/concepts/queue)。

## Streaming, chunking, and batching

區塊串流在模型產生文本區塊時會發送部分回覆。分塊則遵循通道文本限制，並避免拆分有邊界的程式碼。

關鍵設定：

- `agents.defaults.blockStreamingDefault` (`on|off`, 預設為關閉)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (基於閒置的批次處理)
- `agents.defaults.humanDelay` (區塊回覆之間類似人類的暫停)
- 頻道覆蓋：`*.blockStreaming` 和 `*.blockStreamingCoalesce` (非 Telegram 頻道需要明確的 `*.blockStreaming: true`)

細節：[串流 + 分塊](/concepts/streaming)。

## 理由可見性與 token

OpenClaw 可以公開或隱藏模型推理：

- `/reasoning on|off|stream` 控制可見性。
- 當模型產生推理內容時，仍然計入 token 使用量。
- Telegram 支援將推理流整合進草稿氣泡中。

細節: [思考 + 推理指令](/tools/thinking) 和 [Token 使用](/reference/token-use)。

## 前綴、線程與回覆

Outbound message formatting is centralized in `messages`:

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 和 `channels.<channel>.accounts.<id>.responsePrefix`（外發前綴級聯），加上 `channels.whatsapp.messagePrefix`（WhatsApp 內部前綴）
- 透過 `replyToMode` 進行回覆串接及每個通道的預設設定

細節：[[BLOCK_1]] [設定](/gateway/configuration#messages) 和頻道文件。[[BLOCK_2]]
