---
summary: "訊息流、工作階段、佇列和推論可見性"
read_when:
  - 解釋內送訊息如何變成回覆
  - 闡明工作階段、佇列模式或串流行為
  - 文件化推論可見性和使用影響
title: "訊息"
---

# 訊息

本頁將 OpenClaw 如何處理內送訊息、工作階段、佇列、串流和推論可見性整合在一起。

## 訊息流（高階）

```
內送訊息
  -> 路由/綁定 -> 工作階段金鑰
  -> 佇列 (如果運行中)
  -> 智慧代理運行（串流 + 工具）
  -> 外送回覆（頻道限制 + 分塊）
```

主要控制項位於設定中：

- `messages.*` 用於前綴、佇列和群組行為。
- `agents.defaults.*` 用於區塊串流傳輸和分塊預設值。
- 頻道覆蓋 (`channels.whatsapp.*`、`channels.telegram.*` 等) 用於上限和串流切換。

請參閱 [Configuration](/gateway/configuration) 了解完整綱要。

## 內送去重複

頻道可以在重新連接後重新傳遞相同的訊息。OpenClaw 會維護一個由頻道/帳戶/對等/工作階段/訊息 ID 鍵控的短暫快取，因此重複傳遞不會觸發另一個智慧代理運行。

## 內送去抖動

來自**相同寄件者**的快速連續訊息可以透過 `messages.inbound` 批次處理成單一智慧代理回合。去抖動的範圍是每個頻道 + 對話，並使用最新訊息進行回覆執行緒/ID。

設定（全域預設值 + 每頻道覆蓋）：

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

- 去抖動適用於**純文字**訊息；媒體/附件會立即刷新。
- 控制命令會繞過去抖動，因此它們保持獨立。

## 工作階段和裝置

工作階段由 Gateway 擁有，而非用戶端。

- 直接聊天會合併到智慧代理主要工作階段金鑰。
- 群組/頻道會獲得自己的工作階段金鑰。
- 工作階段儲存和轉錄檔位於 Gateway 主機上。

多個裝置/頻道可以映射到相同的工作階段，但歷史記錄不會完全同步回每個用戶端。建議：對於長時間對話，請使用一個主要裝置，以避免上下文分歧。Control UI 和 TUI 始終顯示 Gateway 支援的工作階段轉錄檔，因此它們是事實的來源。

詳細資訊：[Session management](/concepts/session)。

## 內送主體和歷史上下文

OpenClaw 將**提示主體**與**命令主體**分開：

- `Body`：傳送給智慧代理的提示文字。這可能包括頻道封包和可選的歷史包裝器。
- `CommandBody`：用於指令/命令解析的原始使用者文字。
- `RawBody`：`CommandBody` 的舊別名（為相容性而保留）。

當頻道提供歷史記錄時，它使用共用包裝器：

- `[自您上次回覆後的聊天訊息 - 僅供上下文參考]`
- `[目前訊息 - 回覆此訊息]`

對於**非直接聊天**（群組/頻道/聊天室），**目前訊息主體**會以寄件者標籤為前綴（與歷史條目使用的樣式相同）。這使得即時訊息和佇列/歷史訊息在智慧代理提示中保持一致。

歷史緩衝區是**僅待處理**：它們包括**未**觸發運行的群組訊息（例如，提及受限的訊息）並**排除**已在工作階段轉錄檔中的訊息。

指令剝離僅適用於**目前訊息**部分，因此歷史記錄保持完整。包裝歷史記錄的頻道應將 `CommandBody`（或 `RawBody`）設定為原始訊息文字，並將 `Body` 保留為組合提示。歷史緩衝區可透過 `messages.groupChat.historyLimit`（全域預設值）和每頻道覆蓋（例如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`）進行設定（設定 `0` 以停用）。

## 佇列和後續追蹤

如果運行已啟用，內送訊息可以排入佇列、引導到目前運行，或收集以進行後續回合。

- 透過 `messages.queue`（和 `messages.queue.byChannel`）進行設定。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及積壓變體。

詳細資訊：[Queueing](/concepts/queue)。

## 串流、分塊和批次處理

區塊串流傳輸在模型產生文字區塊時傳送部分回覆。分塊遵循頻道文字限制，並避免分割柵欄式程式碼。

主要設定：

- `agents.defaults.blockStreamingDefault` (`on|off`，預設為 off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (基於閒置的批次處理)
- `agents.defaults.humanDelay` (區塊回覆之間類似人類的暫停)
- 頻道覆蓋：`*.blockStreaming` 和 `*.blockStreamingCoalesce`（非 Telegram 頻道需要明確的 `*.blockStreaming: true`）

詳細資訊：[Streaming + chunking](/concepts/streaming)。

## 推論可見性和權杖

OpenClaw 可以顯示或隱藏模型推論：

- `/reasoning on|off|stream` 控制可見性。
- 推論內容在模型產生時仍計入權杖用量。
- Telegram 支援將推論串流傳輸到草稿氣泡中。

詳細資訊：[Thinking + reasoning directives](/tools/thinking) 和 [Token use](/reference/token-use)。

## 前綴、執行緒和回覆

外送訊息格式化集中在 `messages` 中：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 和 `channels.<channel>.accounts.<id>.responsePrefix`（外送前綴級聯），以及 `channels.whatsapp.messagePrefix` (WhatsApp 內送前綴)
- 透過 `replyToMode` 和每頻道預設值進行回覆執行緒

詳細資訊：[Configuration](/gateway/configuration#messages) 和頻道文件。
