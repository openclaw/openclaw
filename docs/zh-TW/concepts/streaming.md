---
summary: "Streaming + chunking behavior (block replies, draft streaming, limits)"
read_when:
  - 說明串流或分塊在各頻道中的運作方式
  - 變更區塊串流或頻道分塊行為
  - 偵錯重複／過早的區塊回覆或草稿串流
title: "Streaming and Chunking"
---

# 串流 + 分塊

OpenClaw 有兩個獨立的「串流」層級：

- **Block streaming (channels):** emit completed **blocks** as the assistant writes. These are normal channel messages (not token deltas).
- **類 token 串流（僅 Telegram）：** 在生成期間以部分文字更新 **草稿泡泡**；最終訊息於結尾送出。

目前 **沒有真正的 token 串流** 會送到外部頻道訊息。Telegram 草稿串流是唯一的部分串流介面。 Telegram draft streaming is the only partial-stream surface.

## 區塊串流（頻道訊息）

Block streaming sends assistant output in coarse chunks as it becomes available.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`：模型串流事件（對非串流模型可能較為稀疏）。
- `chunker`：套用最小／最大界限 + 斷行偏好的 `EmbeddedBlockChunker`。
- `channel send`：實際對外送出的訊息（區塊回覆）。

**控制項：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（預設關閉）。
- Channel overrides: `*.blockStreaming` (and per-account variants) to force `"on"`/`"off"` per channel.
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（在送出前合併串流區塊）。
- 頻道硬性上限：`*.textChunkLimit`（例如 `channels.whatsapp.textChunkLimit`）。
- 頻道分塊模式：`*.chunkMode`（預設 `length`；`newline` 會在長度分塊前，先依空白行（段落邊界）分割）。
- Discord 軟性上限：`channels.discord.maxLinesPerMessage`（預設 17），會拆分過高的回覆以避免 UI 裁切。

**邊界語意：**

- `text_end`：一旦分塊器輸出就串流區塊；在每個 `text_end` 時清空送出。
- `message_end`：等助理訊息完成後，再一次清空送出緩衝的輸出。

`message_end` 若緩衝文字超過 `maxChars`，仍會使用分塊器，因此結尾可能送出多個區塊。

## 分塊演算法（低／高界限）

區塊分塊由 `EmbeddedBlockChunker` 實作：

- **低界限：** 在緩衝區 < `minChars` 前不送出（除非被強制）。
- **高界限：** 優先在 `maxChars` 之前分割；若被強制，則在 `maxChars` 分割。
- **斷行偏好：** `paragraph` → `newline` → `sentence` → `whitespace` → 強制斷行。
- **Code fences:** never split inside fences; when forced at `maxChars`, close + reopen the fence to keep Markdown valid.

`maxChars` 會被限制在頻道的 `textChunkLimit`，因此無法超過各頻道上限。

## 合併（合併串流區塊）

When block streaming is enabled, OpenClaw can **merge consecutive block chunks**
before sending them out. This reduces “single-line spam” while still providing
progressive output.

- Coalescing waits for **idle gaps** (`idleMs`) before flushing.
- Buffers are capped by `maxChars` and will flush if they exceed it.
- `minChars` 會避免在累積到足夠文字前送出微小片段
  （最終清空一定會送出剩餘文字）。
- 連接符號源自 `blockStreamingChunk.breakPreference`
  （`paragraph` → `\n\n`、`newline` → `\n`、`sentence` → 空白）。
- 可透過 `*.blockStreamingCoalesce` 提供頻道覆寫（包含各帳戶設定）。
- 預設合併 `minChars` 在 Signal／Slack／Discord 會提升至 1500，除非被覆寫。

## 1. 區塊之間的人類化節奏

2. 當啟用區塊串流時，你可以在區塊回覆之間加入**隨機暫停**（第一個區塊之後）。 3. 這會讓多氣泡回應感覺更自然。

- 設定：`agents.defaults.humanDelay`（可透過 `agents.list[].humanDelay` 為每個代理程式覆寫）。
- 模式：`off`（預設）、`natural`（800–2500ms）、`custom`（`minMs`/`maxMs`）。
- 僅適用於 **區塊回覆**，不適用於最終回覆或工具摘要。

## 「串流分塊或一次送出」

4. 這對應到：

- **串流分塊：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（邊產生邊送出）。非 Telegram 頻道還需要 `*.blockStreaming: true`。 5. 非 Telegram 頻道也需要 `*.blockStreaming: true`。
- **結尾一次串流全部：** `blockStreamingBreak: "message_end"`（只清空一次；若非常長，可能分成多個區塊）。
- **不使用區塊串流：** `blockStreamingDefault: "off"`（僅最終回覆）。

**頻道注意事項：** 對非 Telegram 頻道而言，除非明確將
`*.blockStreaming` 設為 `true`，否則區塊串流 **預設關閉**。Telegram 可在沒有區塊回覆的情況下進行草稿串流（`channels.telegram.streamMode`）。 6. Telegram 可以在沒有區塊回覆的情況下串流草稿（`channels.telegram.streamMode`）。

設定位置提醒：`blockStreaming*` 的預設值位於
`agents.defaults` 之下，而不是根設定。

## Telegram 草稿串流（類 token）

Telegram 是唯一支援草稿串流的頻道：

- 使用 Bot API `sendMessageDraft`，適用於 **有主題的私人聊天**。
- `channels.telegram.streamMode: "partial" | "block" | "off"`。
  - `partial`：以最新串流文字更新草稿。
  - `block`：以分塊區塊更新草稿（相同的分塊規則）。
  - `off`：不進行草稿串流。
- 草稿分塊設定（僅適用於 `streamMode: "block"`）：`channels.telegram.draftChunk`（預設：`minChars: 200`、`maxChars: 800`）。
- 草稿串流與區塊串流是分離的；區塊回覆預設關閉，且在非 Telegram 頻道上僅能由 `*.blockStreaming: true` 啟用。
- 7. 最終回覆仍然是一則一般訊息。
- 8. `/reasoning stream` 會將推理寫入草稿氣泡（僅限 Telegram）。

當草稿串流啟用時，OpenClaw 會為該次回覆停用區塊串流，以避免雙重串流。

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

9. 圖例：

- `sendMessageDraft`：Telegram 草稿泡泡（不是真實訊息）。
- `final reply`：一般的 Telegram 訊息送出。
