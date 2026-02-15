```
---
summary: "串流 + 分塊行為（區塊回覆、草稿串流、限制）"
read_when:
  - 解釋串流或分塊在通道上的運作方式
  - 更改區塊串流或通道分塊行為
  - 偵錯重複/過早的區塊回覆或草稿串流
title: "串流與分塊"
---

# 串流 + 分塊

OpenClaw 有兩個獨立的「串流」層：

- **區塊串流 (通道)：** 在助理撰寫時，發送已完成的**區塊**。這些是正常的通道訊息（不是 token 差異）。
- **近似 token 的串流 (僅限 Telegram)：** 在生成時以部分文字更新**草稿泡泡**；最終訊息在結束時發送。

目前外部通道訊息**沒有真正的 token 串流**。Telegram 草稿串流是唯一的部分串流介面。

## 區塊串流 (通道訊息)

區塊串流在助理輸出可用時，以粗略的塊發送。

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

圖例：

- `text_delta/events`：模型串流事件（對於非串流模型可能稀疏）。
- `chunker`：`EmbeddedBlockChunker` 套用最小/最大界限 + 中斷偏好。
- `channel send`：實際的出站訊息（區塊回覆）。

**控制項：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"` (預設關閉)。
- 通道覆寫：`*.blockStreaming` (以及每個帳號的變體) 以強制每個通道開啟/關閉。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }` (在發送前合併串流區塊)。
- 通道硬限制：`*.textChunkLimit` (例如，`channels.whatsapp.textChunkLimit`)。
- 通道分塊模式：`*.chunkMode` (`length` 預設，`newline` 在長度分塊前按空行（段落邊界）分割)。
- Discord 軟限制：`channels.discord.maxLinesPerMessage` (預設 17) 分割高回復以避免 UI 截斷。

**邊界語意：**

- `text_end`：分塊器發送後立即串流區塊；在每個 `text_end` 時清除。
- `message_end`：等待助理訊息完成，然後清除緩衝輸出。

如果緩衝文字超過 `maxChars`，`message_end` 仍然會使用分塊器，這樣它就可以在結束時發送多個分塊。

## 分塊演算法 (低/高界限)

區塊分塊由 `EmbeddedBlockChunker` 實現：

- **低界限：** 在緩衝區 >= `minChars` 之前不發送（除非強制）。
- **高界限：** 優先在 `maxChars` 之前分割；如果強制，則在 `maxChars` 處分割。
- **中斷偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 硬中斷。
- **程式碼區塊：** 絕不應在程式碼區塊內部進行分割；當在 `maxChars` 處強制分割時，關閉並重新打開區塊以保持 Markdown 有效。

`maxChars` 被限制在通道的 `textChunkLimit`，因此您不能超過每個通道的限制。

## 合併 (合併串流區塊)

啟用區塊串流時，OpenClaw 可以在發送前**合併連續的區塊塊**。這減少了「單行垃圾訊息」，同時仍然提供漸進式輸出。

- 合併會等待**閒置間隔** (`idleMs`) 後再清除。
- 緩衝區受 `maxChars` 限制，如果超過則會清除。
- `minChars` 防止微小的片段在累積足夠文字之前發送（最終清除總是會發送剩餘文字）。
- 連接符號源自 `blockStreamingChunk.breakPreference` (`paragraph` → `\n\n`，`newline` → `\n`，`sentence` → 空格)。
- 可透過 `*.blockStreamingCoalesce` (包括每個帳號設定) 進行通道覆寫。
- Signal/Slack/Discord 的預設合併 `minChars` 會提高到 1500，除非被覆寫。

## 區塊之間的人性化節奏

啟用區塊串流時，您可以在區塊回覆之間（在第一個區塊之後）添加一個**隨機暫停**。這使得多泡泡回覆感覺更自然。

- 設定：`agents.defaults.humanDelay` (透過 `agents.list[].humanDelay` 覆寫每個代理)。
- 模式：`off` (預設)，`natural` (800–2500ms)，`custom` (`minMs`/`maxMs`)。
- 僅適用於**區塊回覆**，不適用於最終回覆或工具摘要。

## 「串流分塊或全部」

這對應於：

- **串流分塊：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (邊生成邊發送)。非 Telegram 通道也需要 `*.blockStreaming: true`。
- **在結束時串流所有內容：** `blockStreamingBreak: "message_end"` (一次性清除，如果非常長則可能有多個分塊)。
- **無區塊串流：** `blockStreamingDefault: "off"` (僅最終回覆)。

**通道備註：** 對於非 Telegram 通道，區塊串流**預設為關閉**，除非 `*.blockStreaming` 被明確設定為 `true`。Telegram 無需區塊回覆即可串流草稿 (`channels.telegram.streamMode`)。

設定位置提醒：`blockStreaming*` 預設值位於 `agents.defaults` 下，而不是根設定。

## Telegram 草稿串流 (近似 token)

Telegram 是唯一支援草稿串流的通道：

- 在**帶有主題的私人聊天室**中使用 Bot API `sendMessageDraft`。
- `channels.telegram.streamMode: "partial" | "block" | "off"`。
  - `partial`：草稿以最新的串流文字更新。
  - `block`：草稿以分塊區塊更新（與分塊器規則相同）。
  - `off`：無草稿串流。
- 草稿分塊設定 (僅適用於 `streamMode: "block"`)：`channels.telegram.draftChunk` (預設值：`minChars: 200`，`maxChars: 800`)。
- 草稿串流與區塊串流是分開的；區塊回覆預設為關閉，僅在非 Telegram 通道上透過 `*.blockStreaming: true` 啟用。
- 最終回覆仍然是正常訊息。
- `/reasoning stream` 將推理寫入草稿泡泡 (僅限 Telegram)。

當草稿串流啟用時，OpenClaw 會停用該回覆的區塊串流，以避免雙重串流。

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

圖例：

- `sendMessageDraft`：Telegram 草稿泡泡 (不是真正的訊息)。
- `final reply`：正常 Telegram 訊息發送。
```
