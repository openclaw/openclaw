---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - Explaining how inbound messages become replies
  - "Clarifying sessions, queueing modes, or streaming behavior"
  - Documenting reasoning visibility and usage implications
title: Messages
---

# 訊息

本頁說明 OpenClaw 如何處理進站訊息、會話、排程、串流及推理可見性。

## 訊息流程（高階）

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

主要設定參數位於設定中：

- `messages.*` 用於前綴、排程及群組行為。
- `agents.defaults.*` 用於區塊串流與分段預設。
- 頻道覆寫 (`channels.whatsapp.*`、`channels.telegram.*` 等) 用於限制與串流開關。

完整架構請參考 [Configuration](/gateway/configuration)。

## 進站去重

頻道在重新連線後可能會重複傳送相同訊息。OpenClaw 會維護一個以頻道/帳號/對等端/會話/訊息 ID 為鍵的短期快取，避免重複傳送觸發多次代理執行。

## 進站去彈跳

來自**同一發送者**的快速連續訊息，可透過 `messages.inbound` 合併成單一代理回合。去彈跳範圍以頻道 + 對話為單位，並使用最新訊息作為回覆串接/ID。

設定（全域預設 + 各頻道覆寫）：

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

- 去彈跳僅適用於**純文字**訊息；媒體/附件會立即送出。
- 控制指令會跳過去彈跳，保持獨立執行。

## 會話與裝置

會話由閘道器擁有，而非用戶端。

- 直接聊天會合併到代理主會話金鑰中。
- 群組/頻道會有自己的會話金鑰。
- 會話存儲和對話記錄存在於閘道器主機上。

多個裝置/頻道可以對應到同一會話，但歷史不會完全同步回每個用戶端。建議：長時間對話使用一個主要裝置，以避免上下文分歧。控制介面（Control UI）和文字使用者介面（TUI）始終顯示由閘道器支援的會話記錄，因此它們是事實的來源。

詳細資訊：[會話管理](/concepts/session)。

## 傳入內容與歷史上下文

OpenClaw 將 **提示內容** 與 **指令內容** 分開：

- `Body`：傳送給代理的提示文字。可能包含頻道信封與可選的歷史包裝。
- `CommandBody`：用於指令/命令解析的原始使用者文字。
- `RawBody`：`CommandBody` 的舊版別名（為相容性保留）。

當頻道提供歷史時，會使用共用包裝：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

對於 **非直接聊天**（群組/頻道/聊天室），**目前訊息內容**會加上發送者標籤（與歷史條目使用相同風格）。這讓即時與排隊/歷史訊息在代理提示中保持一致。

歷史緩衝區是 **僅待處理**：包含未觸發執行的群組訊息（例如需提及才能觸發的訊息），並且**不包含**已在會話記錄中的訊息。

指令剝除只適用於**目前訊息**部分，歷史保持完整。包裝歷史的頻道應將 `CommandBody`（或 `RawBody`）設為原始訊息文字，並保持 `Body` 為合併後的提示。歷史緩衝區可透過 `messages.groupChat.historyLimit`（全域預設）及頻道覆寫如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit` 進行設定（設置 `0` 可停用）。

## 排隊與後續處理

如果執行已在進行中，傳入訊息可以排隊、導入目前執行流程，或收集為後續回合。

- 透過 `messages.queue`（及 `messages.queue.byChannel`）進行設定。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及待辦清單變體。

詳細資訊：[排隊](/concepts/queue)。

## 串流、分塊與批次處理

區塊串流會在模型產生文字區塊時，傳送部分回覆。
分塊會遵守頻道文字限制，並避免拆分有框程式碼。

主要設定：

- `agents.defaults.blockStreamingDefault`（`on|off`，預設關閉）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基於閒置的批次處理）
- `agents.defaults.humanDelay`（區塊回覆間的人類般暫停）
- 頻道覆寫：`*.blockStreaming` 和 `*.blockStreamingCoalesce`（非 Telegram 頻道需明確設定 `*.blockStreaming: true`）

詳細資訊：[串流 + 分塊](/concepts/streaming)。

## 推理可見性與 token

OpenClaw 可顯示或隱藏模型推理：

- `/reasoning on|off|stream` 控制可見性。
- 推理內容在模型產生時仍會計入 token 使用量。
- Telegram 支援將推理串流顯示於草稿氣泡中。

詳細資訊：[思考 + 推理指令](/tools/thinking) 及 [Token 使用](/reference/token-use)。

## 前綴、串接與回覆

外發訊息格式集中管理於 `messages`：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 和 `channels.<channel>.accounts.<id>.responsePrefix`（外發前綴階層），以及 `channels.whatsapp.messagePrefix`（WhatsApp 內部前綴）
- 透過 `replyToMode` 及各頻道預設進行回覆串接

詳細資訊：[設定](/gateway/configuration#messages) 及頻道文件。
