---
summary: "訊息流程、工作階段、佇列和推理可見性"
read_when:
  - 說明傳入訊息如何轉化為回覆
  - 澄清工作階段、佇列模式或串流行為
  - 記錄推理可見性和使用影響
title: "訊息"
---

# 訊息

本頁面整合了 OpenClaw 處理傳入訊息、工作階段、佇列、串流以及推理可見性的方式。

## 訊息流程（高層級）

```
傳入訊息
  -> routing/bindings -> session key
  -> 佇列 (若有執行中的任務)
  -> 智慧代理執行 (串流 + 工具)
  -> 傳出回覆 (頻道限制 + 分塊)
```

關鍵控制項位於設定中：

- `messages.*` 用於前綴、佇列和群組行為。
- `agents.defaults.*` 用於區塊串流傳輸和分塊預設值。
- 頻道覆蓋 (`channels.whatsapp.*`、`channels.telegram.*` 等）用於上限和串流切換。

詳情請參閱 [設定](/gateway/configuration) 了解完整 Schema。

## 傳入去重 (Dedupe)

頻道在重新連線後可能會重複傳送相同的訊息。OpenClaw 會保留一個短期的快取，以 channel/account/peer/session/message id 為鍵值，因此重複的傳送不會觸發另一次智慧代理執行。

## 傳入防抖 (Debouncing)

來自**同一位發送者**的快速連續訊息可以透過 `messages.inbound` 合併到單次智慧代理輪次中。防抖的作用範圍是每個頻道 + 對話，並使用最近的訊息進行回覆串接/ID 處理。

設定（全域預設 + 各頻道覆蓋）：

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

- 防抖僅適用於**純文字**訊息；媒體/附件會立即發送。
- 控制指令會跳過防抖，以便保持獨立。

## 工作階段與裝置

工作階段由 Gateway 擁有，而非由用戶端擁有。

- 私訊會摺疊至智慧代理的主工作階段金鑰 (session key)。
- 群組/頻道擁有各自的工作階段金鑰。
- 工作階段儲存空間和對話紀錄存放在 Gateway 主機上。

多個裝置/頻道可以映射到同一個工作階段，但歷史紀錄不會完全同步回每個用戶端。建議：針對長對話使用一個主要裝置，以避免上下文分歧。Control UI 和 TUI 始終顯示由 Gateway 支援的工作階段對話紀錄，因此它們是單一事實來源。

詳情請參閱：[工作階段管理](/concepts/session)。

## 傳入內容與歷史上下文

OpenClaw 將 **prompt body** 與 **command body** 分開：

- `Body`: 傳送給智慧代理的提示詞文本。這可能包含頻道封裝和選用的歷史包裝器。
- `CommandBody`: 用於指令/命令解析的原始使用者文本。
- `RawBody`: `CommandBody` 的舊版別名（保留用於相容性）。

當頻道提供歷史紀錄時，會使用共用的包裝器：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

對於**非私訊**（群組/頻道/聊天室），**當前訊息內容**會加上發送者標籤的前綴（與歷史項目使用的樣式相同）。這能讓即時訊息與佇列/歷史訊息在智慧代理提示詞中保持一致。

歷史緩衝區**僅限待處理項目**：它們包含未觸發執行的群組訊息（例如：被提及過濾的訊息），且**排除**已存在於工作階段對話紀錄中的訊息。

指令剝離 (Directive stripping) 僅適用於**當前訊息**部分，以便歷史紀錄保持完整。封裝歷史紀錄的頻道應將 `CommandBody`（或 `RawBody`）設定為原始訊息文本，並將 `Body` 保留為合併後的提示詞。歷史緩衝區可透過 `messages.groupChat.historyLimit`（全域預設）以及各頻道的覆蓋設定進行調整，例如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`（設定為 `0` 則禁用）。

## 佇列與後續行動

若已有執行中的任務，傳入訊息可以進入佇列、引導至當前執行任務，或收集用於後續輪次。

- 透過 `messages.queue` (及 `messages.queue.byChannel`) 進行設定。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及待辦項目 (backlog) 變體。

詳情請參閱：[佇列](/concepts/queue)。

## 串流、分塊與批次處理

區塊串流傳輸會在模型產生文本塊時傳送部分回覆。分塊會遵守頻道的文本限制，並避免切割圍欄代碼塊 (fenced code)。

關鍵設定：

- `agents.defaults.blockStreamingDefault` (`on|off`，預設為關閉)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (基於閒置的批次處理)
- `agents.defaults.humanDelay` (區塊回覆之間的人類化停頓)
- 頻道覆蓋：`*.blockStreaming` 和 `*.blockStreamingCoalesce` (非 Telegram 頻道需要顯式設定 `*.blockStreaming: true`)

詳情請參閱：[串流 + 分塊](/concepts/streaming)。

## 推理可見性與 Token

OpenClaw 可以顯示或隱藏模型推理：

- `/reasoning on|off|stream` 控制可見性。
- 推理內容由模型產生時，仍會計入 Token 使用量。
- Telegram 支援將推理串流顯示在草稿氣泡中。

詳情請參閱：[思考 + 推理指令](/tools/thinking) 和 [Token 使用](/reference/token-use)。

## 前綴、串文與回覆

傳出訊息的格式化集中在 `messages` 中：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 和 `channels.<channel>.accounts.<id>.responsePrefix` (傳出前綴級聯)，以及 `channels.whatsapp.messagePrefix` (WhatsApp 傳入前綴)
- 透過 `replyToMode` 和各頻道預設值進行回覆串接 (Reply threading)

詳情請參閱：[設定](/gateway/configuration#messages) 和頻道文件。
