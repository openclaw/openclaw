---
summary: 「串流 + 分塊行為（區塊回覆、草稿串流、限制）」
read_when:
  - 說明串流或分塊在各頻道中的運作方式
  - 變更區塊串流或頻道分塊行為
  - 偵錯重複／過早的區塊回覆或草稿串流
title: 「串流與分塊」
x-i18n:
  source_path: concepts/streaming.md
  source_hash: f014eb1898c4351b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:55Z
---

# 串流 + 分塊

OpenClaw 有兩個獨立的「串流」層級：

- **區塊串流（頻道）：** 隨著助理撰寫內容，送出已完成的 **區塊**。這些是一般的頻道訊息（不是 token 差量）。
- **類 token 串流（僅 Telegram）：** 在生成期間以部分文字更新 **草稿泡泡**；最終訊息於結尾送出。

目前 **沒有真正的 token 串流** 會送到外部頻道訊息。Telegram 草稿串流是唯一的部分串流介面。

## 區塊串流（頻道訊息）

區塊串流會在可用時，將助理輸出以較粗的區塊分段送出。

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

- `text_delta/events`：模型串流事件（對非串流模型可能較為稀疏）。
- `chunker`：套用最小／最大界限 + 斷行偏好的 `EmbeddedBlockChunker`。
- `channel send`：實際對外送出的訊息（區塊回覆）。

**控制項：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（預設關閉）。
- 頻道覆寫：`*.blockStreaming`（以及各帳戶變體），可為每個頻道強制 `"on"`/`"off"`。
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
- **程式碼圍欄：** 絕不在圍欄內分割；若被迫在 `maxChars` 分割，會先關閉再重新開啟圍欄，以維持 Markdown 有效性。

`maxChars` 會被限制在頻道的 `textChunkLimit`，因此無法超過各頻道上限。

## 合併（合併串流區塊）

啟用區塊串流時，OpenClaw 可在送出前 **合併連續的區塊分段**。
這能在仍提供漸進輸出的同時，減少「單行洗版」。

- 合併會等待 **閒置間隔**（`idleMs`）後才清空送出。
- 緩衝區受 `maxChars` 限制，超過即會送出。
- `minChars` 會避免在累積到足夠文字前送出微小片段
  （最終清空一定會送出剩餘文字）。
- 連接符號源自 `blockStreamingChunk.breakPreference`
  （`paragraph` → `\n\n`、`newline` → `\n`、`sentence` → 空白）。
- 可透過 `*.blockStreamingCoalesce` 提供頻道覆寫（包含各帳戶設定）。
- 預設合併 `minChars` 在 Signal／Slack／Discord 會提升至 1500，除非被覆寫。

## 區塊之間的人性化節奏

啟用區塊串流時，可在區塊回覆之間（第一個區塊之後）加入 **隨機暫停**。
這會讓多氣泡回覆感覺更自然。

- 設定：`agents.defaults.humanDelay`（可透過 `agents.list[].humanDelay` 為每個代理程式覆寫）。
- 模式：`off`（預設）、`natural`（800–2500ms）、`custom`（`minMs`/`maxMs`）。
- 僅適用於 **區塊回覆**，不適用於最終回覆或工具摘要。

## 「串流分塊或一次送出」

對應如下：

- **串流分塊：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（邊產生邊送出）。非 Telegram 頻道還需要 `*.blockStreaming: true`。
- **結尾一次串流全部：** `blockStreamingBreak: "message_end"`（只清空一次；若非常長，可能分成多個區塊）。
- **不使用區塊串流：** `blockStreamingDefault: "off"`（僅最終回覆）。

**頻道注意事項：** 對非 Telegram 頻道而言，除非明確將
`*.blockStreaming` 設為 `true`，否則區塊串流 **預設關閉**。Telegram 可在沒有區塊回覆的情況下進行草稿串流（`channels.telegram.streamMode`）。

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
- 最終回覆仍是一般訊息。
- `/reasoning stream` 會將推理寫入草稿泡泡（僅 Telegram）。

當草稿串流啟用時，OpenClaw 會為該次回覆停用區塊串流，以避免雙重串流。

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

圖例：

- `sendMessageDraft`：Telegram 草稿泡泡（不是真實訊息）。
- `final reply`：一般的 Telegram 訊息送出。
