---
summary: "串流與分塊行為 (區塊回覆、草稿串流、限制)"
read_when:
  - 說明頻道上的串流或分塊運作方式
  - 變更區塊串流或頻道分塊行為
  - 排除重複/提早的區塊回覆或草稿串流問題
title: "串流與分塊"
---

# 串流與分塊

OpenClaw 具有兩個獨立的「串流」層級：

- **區塊串流 (頻道)：** 在智慧代理撰寫時發送完整的**區塊**。這些是正常的頻道訊息（並非 token 增量）。
- **Token 式串流 (僅限 Telegram)：** 在生成時以部分文字更新**草稿對話框**；最終訊息會在結束時發送。

目前**沒有真正的 token 串流**到外部頻道訊息。Telegram 草稿串流是唯一的局部串流介面。

## 區塊串流 (頻道訊息)

區塊串流在智慧代理的輸出可用時，以粗略的分塊方式發送。

```
模型輸出
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ 分塊器隨著緩衝區成長發送區塊
       └─ (blockStreamingBreak=message_end)
            └─ 分塊器在 message_end 時排空
                   └─ 頻道發送 (區塊回覆)
```

圖例：

- `text_delta/events`：模型串流事件（對於非串流模型可能較為稀疏）。
- `chunker`：套用最小/最大界限 + 中斷偏好的 `EmbeddedBlockChunker`。
- `channel send`：實際發出的訊息（區塊回覆）。

**控制項：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"` (預設為 off)。
- 頻道覆蓋：`*.blockStreaming` (以及個別帳號變體) 以針對每個頻道強制設定 `"on"`/`"off"`。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }` (在發送前合併串流區塊)。
- 頻道硬性上限：`*.textChunkLimit` (例如 `channels.whatsapp.textChunkLimit`)。
- 頻道分塊模式：`*.chunkMode` (`length` 為預設，`newline` 在長度分塊前先於空白行 (段落邊界) 處拆分)。
- Discord 軟性上限：`channels.discord.maxLinesPerMessage` (預設 17) 拆分過長的回覆以避免 UI 裁切。

**邊界語義：**

- `text_end`：分塊器發出後立即串流區塊；在每個 `text_end` 時排空。
- `message_end`：等待智慧代理訊息完成後，再排空緩衝區輸出。

即使使用 `message_end`，若緩衝文字超過 `maxChars`，仍會使用分塊器，因此最後可能會發送多個分塊。

## 分塊演算法 (低/高界限)

區塊分塊由 `EmbeddedBlockChunker` 實作：

- **下限：** 緩衝區不足 `minChars` 前不發送（除非強制發送）。
- **上限：** 優先在 `maxChars` 之前分割；若強制分割，則在 `maxChars` 處分割。
- **中斷偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 硬性中斷。
- **程式碼圍欄：** 絕不在圍欄內分割；若在 `maxChars` 處強制分割，則會先關閉並重新開啟圍欄以保持 Markdown 語法正確。

`maxChars` 會被限制在頻道的 `textChunkLimit` 之內，因此您不會超過各頻道的上限。

## 合併 (合併串流區塊)

當啟用區塊串流時，OpenClaw 可以在發送前**合併連續的區塊分塊**。這能減少「單行洗版」，同時仍提供漸進式輸出。

- 合併會等待**空閒間隔** (`idleMs`) 後再進行排空。
- 緩衝區受 `maxChars` 限制，超過時將會排空。
- `minChars` 可防止在累積足夠文字前發送微小片段（最終排空時一律會發送剩餘文字）。
- 連接符號衍生自 `blockStreamingChunk.breakPreference` (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → 空格)。
- 可透過 `*.blockStreamingCoalesce` (包含個別帳號設定) 進行頻道覆蓋。
- 除非另行覆蓋，否則 Signal/Slack/Discord 的預設合併 `minChars` 已提升至 1500。

## 區塊間的擬人化節奏

啟用區塊串流時，您可以在區塊回覆之間（第一個區塊之後）增加**隨機停頓**。這使多對話框的回應感覺更自然。

- 設定：`agents.defaults.humanDelay` (可透過 `agents.list[].humanDelay` 針對個別智慧代理進行覆蓋)。
- 模式：`off` (預設)、`natural` (800–2500ms)、`custom` (`minMs`/`maxMs`)。
- 僅適用於**區塊回覆**，不適用於最終回覆或工具摘要。

## 「串流分塊或全部內容」

這對應於：

- **串流分塊：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (隨寫隨發)。非 Telegram 頻道還需要設定 `*.blockStreaming: true`。
- **結尾串流全部內容：** `blockStreamingBreak: "message_end"` (排空一次，若內容極長則可能有多個分塊)。
- **無區塊串流：** `blockStreamingDefault: "off"` (僅發送最終回覆)。

**頻道注意事項：** 對於非 Telegram 頻道，除非明確將 `*.blockStreaming` 設定為 `true`，否則區塊串流為 **off**。Telegram 可以串流草稿 (`channels.telegram.streamMode`) 而不使用區塊回覆。

設定位置提醒：`blockStreaming*` 預設值位於 `agents.defaults` 下，而非根目錄設定。

## Telegram 草稿串流 (Token 式)

Telegram 是唯一具有草稿串流的頻道：

- 在具有主題的**私訊**中使用 Bot API `sendMessageDraft`。
- `channels.telegram.streamMode: "partial" | "block" | "off"`。
  - `partial`：以最新的串流文字更新草稿。
  - `block`：以分塊方式更新草稿（遵循相同的分塊器規則）。
  - `off`：不使用草稿串流。
- 草稿分塊設定 (僅適用於 `streamMode: "block"`)：`channels.telegram.draftChunk` (預設值：`minChars: 200`, `maxChars: 800`)。
- 草稿串流與區塊串流是獨立的；區塊回覆預設為關閉，僅在非 Telegram 頻道上透過 `*.blockStreaming: true` 啟用。
- 最終回覆仍為一般訊息。
- `/reasoning stream` 會將推理過程寫入草稿對話框 (僅限 Telegram)。

當草稿串流啟動時，OpenClaw 會停用該次回覆的區塊串流，以避免重複串流。

```
Telegram (私訊 + 主題)
  └─ sendMessageDraft (草稿對話框)
       ├─ streamMode=partial → 更新最新文字
       └─ streamMode=block   → 分塊器更新草稿
  └─ 最終回覆 → 一般訊息
```

圖例：

- `sendMessageDraft`：Telegram 草稿對話框（並非真實訊息）。
- `final reply`：發送正常的 Telegram 訊息。
