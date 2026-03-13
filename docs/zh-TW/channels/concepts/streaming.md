---
summary: >-
  Streaming + chunking behavior (block replies, channel preview streaming, mode
  mapping)
read_when:
  - Explaining how streaming or chunking works on channels
  - Changing block streaming or channel chunking behavior
  - Debugging duplicate/early block replies or channel preview streaming
title: Streaming and Chunking
---

# Streaming + chunking

OpenClaw 有兩個獨立的串流層：

- **區塊串流（頻道）：** 在助手撰寫時發出已完成的 **區塊**。這些是正常的頻道訊息（不是 token 變化）。
- **預覽串流（Telegram/Discord/Slack）：** 在生成過程中更新臨時的 **預覽訊息**。

目前並沒有**真正的 token-delta 串流**來傳送頻道消息。預覽串流是基於消息的（發送 + 編輯/附加）。

## Block streaming (channel messages)

區塊串流會在助手輸出可用時，以粗略的區塊形式發送。

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

[[BLOCK_1]]

- `text_delta/events`: 模型串流事件（對於非串流模型可能較稀疏）。
- `chunker`: `EmbeddedBlockChunker` 應用最小/最大範圍 + 中斷偏好。
- `channel send`: 實際的外發消息（區塊回覆）。

**Controls:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"`（預設為關閉）。
- 頻道覆蓋：`*.blockStreaming`（以及每個帳戶的變體）以強制每個頻道使用 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`: `"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }`（在發送前合併串流區塊）。
- 頻道硬上限：`*.textChunkLimit`（例如，`channels.whatsapp.textChunkLimit`）。
- 頻道區塊模式：`*.chunkMode`（`length` 為預設，`newline` 在空白行（段落邊界）之前進行分割，然後再進行長度區塊處理）。
- Discord 軟上限：`channels.discord.maxLinesPerMessage`（預設為 17）將高回覆分割以避免 UI 剪裁。

**邊界語義：**

- `text_end`: 一旦 chunker 發出，立即串流區塊；在每個 `text_end` 上進行刷新。
- `message_end`: 等待助手訊息完成後，再刷新緩衝輸出。

`message_end` 仍然使用分塊器，如果緩衝的文本超過 `maxChars`，因此它可以在結尾發出多個塊。

## Chunking 演算法（低/高界限）

區塊分塊是由 `EmbeddedBlockChunker` 實現的：

- **下限：** 直到緩衝區 >= `minChars` 時才發出（除非被強制）。
- **上限：** 優先在 `maxChars` 之前進行拆分；如果被強制，則在 `maxChars` 拆分。
- **斷開偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 硬斷開。
- **程式碼區塊：** 永遠不要在區塊內拆分；當在 `maxChars` 被強制時，關閉並重新打開區塊以保持 Markdown 的有效性。

`maxChars` 被限制在通道 `textChunkLimit`，因此您無法超過每個通道的上限。

## 合併（合併串流區塊）

當區塊串流啟用時，OpenClaw 可以 **合併連續的區塊片段**，然後再發送出去。這樣可以減少「單行垃圾訊息」，同時仍然提供漸進式的輸出。

- 合併會等待 **閒置間隙** (`idleMs`) 才進行清空。
- 緩衝區的上限由 `maxChars` 限制，若超過此上限則會進行清空。
- `minChars` 防止小片段在累積足夠文本之前發送
  （最終清空始終會發送剩餘文本）。
- 連接器是從 `blockStreamingChunk.breakPreference` 派生的
  (`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格)。
- 通道覆蓋可通過 `*.blockStreamingCoalesce` 獲得（包括每個帳戶的設定）。
- 預設合併 `minChars` 被提升至 1500 針對 Signal/Slack/Discord，除非被覆蓋。

## Human-like pacing between blocks

當區塊串流啟用時，您可以在區塊回覆之間添加一個 **隨機暫停**（在第一個區塊之後）。這使得多氣泡回應感覺更加自然。

- 設定: `agents.defaults.humanDelay`（可透過 `agents.list[].humanDelay` 針對每個代理進行覆蓋）。
- 模式: `off`（預設）、`natural`（800–2500毫秒）、`custom` (`minMs`/`maxMs`)。
- 僅適用於 **區塊回覆**，不適用於最終回覆或工具摘要。

## “串流區塊或全部”

這對應到：

- **串流區塊：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（隨時發送）。非 Telegram 頻道也需要 `*.blockStreaming: true`。
- **在結尾串流所有內容：** `blockStreamingBreak: "message_end"`（一次性清空，可能會有多個區塊如果內容非常長）。
- **不支援區塊串流：** `blockStreamingDefault: "off"`（僅最終回覆）。

**頻道說明：** 區塊串流預設為 **關閉，除非** `*.blockStreaming` 明確設置為 `true`。頻道可以在不阻止回覆的情況下串流即時預覽 (`channels.<channel>.streaming`)。

設定位置提醒：`blockStreaming*` 的預設值位於 `agents.defaults`，而不是根設定。

## 預覽串流模式

`channels.<channel>.streaming`

Modes:

- `off`: 停用預覽串流。
- `partial`: 單一預覽，會被最新文本取代。
- `block`: 預覽以分塊/附加的方式更新。
- `progress`: 在生成過程中顯示進度/狀態預覽，最終答案在完成時提供。

### Channel mapping

| 通道     | `off` | `partial` | `block` | `progress`       |
| -------- | ----- | --------- | ------- | ---------------- |
| Telegram | ✅    | ✅        | ✅      | 對應到 `partial` |
| Discord  | ✅    | ✅        | ✅      | 對應到 `partial` |
| Slack    | ✅    | ✅        | ✅      | ✅               |

Slack-only:

- `channels.slack.nativeStreaming` 在 `streaming=partial` 時切換 Slack 原生串流 API 呼叫（預設值：`true`）。

[[BLOCK_1]]  
Legacy key migration:  
[[BLOCK_2]]

- Telegram: `streamMode` + boolean `streaming` 自動遷移至 `streaming` 列舉。
- Discord: `streamMode` + boolean `streaming` 自動遷移至 `streaming` 列舉。
- Slack: `streamMode` 自動遷移至 `streaming` 列舉；boolean `streaming` 自動遷移至 `nativeStreaming`。

### Runtime behavior

Telegram:

- 使用 `sendMessage` + `editMessageText` 在私訊和群組/主題中預覽更新。
- 當 Telegram 明確啟用區塊串流時，預覽串流將被跳過（以避免雙重串流）。
- `/reasoning stream` 可以撰寫推理以進行預覽。

Discord:

- 使用發送 + 編輯預覽訊息。
- `block` 模式使用草稿分塊 (`draftChunk`)。
- 當明確啟用 Discord 區塊串流時，預覽串流將被跳過。

Slack:

- `partial` 可以在可用時使用 Slack 原生串流 (`chat.startStream`/`append`/`stop`)。
- `block` 使用附加式草稿預覽。
- `progress` 使用狀態預覽文字，然後是最終答案。
