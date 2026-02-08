---
summary: 「訊息流程、工作階段、佇列，以及推理可見性」
read_when:
  - 說明傳入訊息如何轉換為回覆
  - 釐清工作階段、佇列模式或串流行為
  - 文件化推理可見性與使用上的影響
title: 「訊息」
x-i18n:
  source_path: concepts/messages.md
  source_hash: 773301d5c0c1e3b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:42Z
---

# 訊息

本頁整合說明 OpenClaw 如何處理傳入訊息、工作階段、佇列、串流，以及推理可見性。

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
- 頻道覆寫（`channels.whatsapp.*`、`channels.telegram.*` 等）用於上限與串流切換。

完整結構請參閱 [設定](/gateway/configuration)。

## 傳入去重（Inbound dedupe）

頻道在重新連線後可能重新投遞相同的訊息。OpenClaw 會維持一個短存活快取，以 頻道 / 帳號 / 對象 / 工作階段 / 訊息 ID 作為鍵，確保重複投遞不會再次觸發代理程式執行。

## 傳入防抖（Inbound debouncing）

來自 **同一寄件者** 的快速連續訊息，可透過 `messages.inbound` 合併為單一代理程式回合。防抖以「頻道 + 對話」為作用範圍，並使用最新訊息來進行回覆串接／ID。

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

- 防抖僅適用於 **純文字** 訊息；媒體／附件會立即送出。
- 控制指令會略過防抖，以保持其獨立性。

## 工作階段與裝置

工作階段由 Gateway 閘道器 擁有，而非用戶端。

- 私聊會合併至代理程式的主要工作階段鍵。
- 群組／頻道各自擁有獨立的工作階段鍵。
- 工作階段儲存與逐字稿位於閘道器主機上。

多個裝置／頻道可以對應到同一個工作階段，但歷史不會完整回同步到每個用戶端。建議：長時間對話請使用單一主要裝置，以避免上下文分歧。控制 UI 與 TUI 一律顯示由閘道器支援的工作階段逐字稿，因此它們是唯一可信來源。

詳情：[工作階段管理](/concepts/session)。

## 傳入內容與歷史上下文

OpenClaw 將 **提示內容** 與 **指令內容** 分離：

- `Body`：送往代理程式的提示文字。這可能包含頻道封裝與選用的歷史包裝。
- `CommandBody`：用於指令／命令解析的原始使用者文字。
- `RawBody`：`CommandBody` 的舊別名（為相容性保留）。

當頻道提供歷史時，會使用共用的包裝格式：

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

對於 **非私聊**（群組／頻道／房間），**目前訊息內容** 會加上寄件者標籤前綴（與歷史項目使用相同樣式）。這可讓即時與佇列／歷史訊息在代理程式提示中保持一致。

歷史緩衝區為 **僅待處理**：它們包含未觸發執行的群組訊息（例如需要提及才觸發的訊息），並 **排除** 已存在於工作階段逐字稿中的訊息。

指令剝離僅套用於 **目前訊息** 區段，以確保歷史保持完整。包裝歷史的頻道應將 `CommandBody`（或 `RawBody`）設為原始訊息文字，並將 `Body` 保持為合併後的提示。歷史緩衝區可透過 `messages.groupChat.historyLimit`（全域預設）與每頻道覆寫（如 `channels.slack.historyLimit` 或 `channels.telegram.accounts.<id>.historyLimit`）進行設定（將 `0` 設為停用）。

## 佇列與後續回合

若已有執行中的回合，傳入訊息可以被佇列、導向目前回合，或收集為後續回合。

- 透過 `messages.queue`（以及 `messages.queue.byChannel`）設定。
- 模式：`interrupt`、`steer`、`followup`、`collect`，以及其 backlog 變體。

詳情：[佇列](/concepts/queue)。

## 串流、分塊與批次

區塊串流會在模型產生文字區塊時即時送出部分回覆。分塊會遵循頻道文字上限，並避免切割圍欄程式碼。

主要設定：

- `agents.defaults.blockStreamingDefault`（`on|off`，預設關閉）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（基於閒置的批次）
- `agents.defaults.humanDelay`（區塊回覆之間的類人暫停）
- 頻道覆寫：`*.blockStreaming` 與 `*.blockStreamingCoalesce`（非 Telegram 頻道需要明確設定 `*.blockStreaming: true`）

詳情：[串流 + 分塊](/concepts/streaming)。

## 推理可見性與權杖

OpenClaw 可顯示或隱藏模型推理：

- `/reasoning on|off|stream` 控制可見性。
- 即使隱藏，模型產生的推理內容仍會計入權杖用量。
- Telegram 支援將推理串流至草稿氣泡。

詳情：[思考 + 推理指令](/tools/thinking) 與 [權杖使用](/reference/token-use)。

## 前綴、串接與回覆

傳出訊息的格式化集中於 `messages`：

- `messages.responsePrefix`、`channels.<channel>.responsePrefix` 與 `channels.<channel>.accounts.<id>.responsePrefix`（傳出前綴級聯），以及 `channels.whatsapp.messagePrefix`（WhatsApp 傳入前綴）
- 透過 `replyToMode` 與每頻道預設值進行回覆串接

詳情：[設定](/gateway/configuration#messages) 與各頻道文件。
