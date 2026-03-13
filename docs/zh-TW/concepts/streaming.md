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

# 串流 + 分塊

OpenClaw 有兩個獨立的串流層：

- **區塊串流（頻道）：** 在助理撰寫時發出已完成的**區塊**。這些是一般的頻道訊息（非 token 差異）。
- **預覽串流（Telegram/Discord/Slack）：** 在生成過程中更新臨時的**預覽訊息**。

目前**沒有真正的 token 差異串流**到頻道訊息。預覽串流是基於訊息的（發送 + 編輯/附加）。

## 區塊串流（頻道訊息）

區塊串流會在助理輸出可用時，以較粗的區塊方式傳送。

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

說明：

- `text_delta/events`：模型串流事件（非串流模型可能較稀疏）。
- `chunker`：`EmbeddedBlockChunker`，套用最小/最大界限與斷點偏好。
- `channel send`：實際發出的訊息（區塊回覆）。

**控制項：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（預設關閉）。
- 頻道覆寫：`*.blockStreaming`（及每帳號變體）用以強制每個頻道的 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（發送前合併串流區塊）。
- 頻道硬上限：`*.textChunkLimit`（例如 `channels.whatsapp.textChunkLimit`）。
- 頻道分塊模式：`*.chunkMode`（`length` 預設，`newline` 在長度分塊前於空白行（段落邊界）分割）。
- Discord 軟上限：`channels.discord.maxLinesPerMessage`（預設 17），分割過長回覆以避免 UI 裁切。

**邊界語意：**

- `text_end`：區塊串流在分塊器發出時立即送出；在每個 `text_end` 時刷新。
- `message_end`：等待助理訊息完成後，再刷新緩衝輸出。

`message_end` 仍會使用分塊器，若緩衝文字超過 `maxChars`，可在結尾發出多個區塊。

## 分塊演算法（低/高界限）

區塊分塊由 `EmbeddedBlockChunker` 實作：

- **下限：** 緩衝區未達 `minChars` 前不輸出（除非被強制）。
- **上限：** 優先在 `maxChars` 前分割；若被強制，則在 `maxChars` 分割。
- **斷點優先順序：** `paragraph` → `newline` → `sentence` → `whitespace` → 強制斷行。
- **程式碼區塊：** 絕不在區塊內分割；若在 `maxChars` 被強制分割，則先關閉再重新開啟區塊，以保持 Markdown 有效。

`maxChars` 會被限制在頻道 `textChunkLimit`，因此無法超過每頻道上限。

## 合併（合併串流區塊）

啟用區塊串流時，OpenClaw 可以**合併連續的區塊分塊**後再輸出。這樣可以減少「單行垃圾訊息」，同時仍提供漸進式輸出。

- 合併會等待**空閒間隔** (`idleMs`) 後才刷新。
- 緩衝區大小受 `maxChars` 限制，超過時會刷新。
- `minChars` 防止過小的片段被送出，直到累積足夠文字（最終刷新會送出剩餘文字）。
- 連接字由 `blockStreamingChunk.breakPreference` 衍生
  （`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格）。
- 頻道覆寫可透過 `*.blockStreamingCoalesce` 設定（包含每帳號設定）。
- Signal/Slack/Discord 預設合併 `minChars` 提升至 1500，除非被覆寫。

## 模擬人類節奏的區塊間停頓

啟用區塊串流時，可以在區塊回覆間（第一個區塊之後）加入**隨機停頓**，讓多氣泡回覆感覺更自然。

- 設定：`agents.defaults.humanDelay`（可透過 `agents.list[].humanDelay` 針對代理覆寫）。
- 模式：`off`（預設）、`natural`（800–2500毫秒）、`custom`（`minMs`/`maxMs`）。
- 僅適用於**區塊回覆**，不適用於最終回覆或工具摘要。

## 「串流分塊或全部」

此設定對應：

- **串流分塊：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（邊產生邊輸出）。非 Telegram 頻道還需 `*.blockStreaming: true`。
- **結束時串流全部：** `blockStreamingBreak: "message_end"`（一次刷新，若內容很長可能包含多個分塊）。
- **不使用區塊串流：** `blockStreamingDefault: "off"`（僅最終回覆）。

**頻道備註：** 除非明確設定 `*.blockStreaming` 為 `true`，否則區塊串流預設關閉。頻道可串流即時預覽（`channels.<channel>.streaming`）但無區塊回覆。

設定位置提醒：`blockStreaming*` 預設位於 `agents.defaults`，而非根目錄設定。

## 預覽串流模式

Canonical key: `channels.<channel>.streaming`

模式：

- `off`：停用預覽串流。
- `partial`：單一預覽，會被最新文字取代。
- `block`：以分段/附加方式更新預覽。
- `progress`：生成過程中的進度/狀態預覽，完成時顯示最終答案。

### 頻道對應

| 頻道     | `off` | `partial` | `block` | `progress`       |
| -------- | ----- | --------- | ------- | ---------------- |
| Telegram | ✅    | ✅        | ✅      | 對應至 `partial` |
| Discord  | ✅    | ✅        | ✅      | 對應至 `partial` |
| Slack    | ✅    | ✅        | ✅      | ✅               |

僅限 Slack：

- `channels.slack.nativeStreaming` 在 `streaming=partial` 時切換 Slack 原生串流 API 呼叫（預設：`true`）。

舊版金鑰遷移：

- Telegram：`streamMode` + 布林值 `streaming` 自動遷移至 `streaming` 列舉型別。
- Discord：`streamMode` + 布林值 `streaming` 自動遷移至 `streaming` 列舉型別。
- Slack：`streamMode` 自動遷移至 `streaming` 列舉型別；布林值 `streaming` 自動遷移至 `nativeStreaming`。

### 執行時行為

Telegram：

- 使用 `sendMessage` + `editMessageText` 於私訊及群組/主題中更新預覽。
- 當 Telegram 區塊串流明確啟用時，會跳過預覽串流（避免重複串流）。
- `/reasoning stream` 可將推理過程寫入預覽。

Discord：

- 使用發送 + 編輯預覽訊息。
- `block` 模式使用草稿分段 (`draftChunk`)。
- 當 Discord 區塊串流明確啟用時，會跳過預覽串流。

Slack：

- `partial` 可以在可用時使用 Slack 原生串流功能 (`chat.startStream`/`append`/`stop`)。
- `block` 採用追加式草稿預覽。
- `progress` 先使用狀態預覽文字，然後顯示最終答案。
