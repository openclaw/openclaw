---
summary: Markdown formatting pipeline for outbound channels
read_when:
  - You are changing markdown formatting or chunking for outbound channels
  - You are adding a new channel formatter or style mapping
  - You are debugging formatting regressions across channels
title: Markdown Formatting
---

# Markdown 格式化

OpenClaw 將外發的 Markdown 格式化為共享的中介表示 (IR)，然後再渲染為特定通道的輸出。IR 保持原始文本不變，同時攜帶樣式/連結範圍，以便在不同通道之間保持分塊和渲染的一致性。

## 目標

- **一致性：** 一個解析步驟，多個渲染器。
- **安全分塊：** 在渲染之前拆分文本，以確保內嵌格式不會在分塊之間中斷。
- **通道適配：** 將相同的 IR 映射到 Slack 的 mrkdwn、Telegram 的 HTML 和 Signal 的樣式範圍，而無需重新解析 Markdown。

## Pipeline

1. **解析 Markdown -> IR**
   - IR 是純文字加上樣式範圍（粗體/斜體/刪除線/程式碼/隱藏內容）和連結範圍。
   - 偏移量是 UTF-16 程式碼單位，因此 Signal 樣式範圍與其 API 對齊。
   - 只有當頻道選擇進行表格轉換時，表格才會被解析。
2. **分塊 IR（格式優先）**
   - 分塊在渲染之前發生於 IR 文字上。
   - 行內格式不會跨塊分割；範圍會根據每個塊進行切割。
3. **按頻道渲染**
   - **Slack:** mrkdwn token（粗體/斜體/刪除線/程式碼），連結作為 `<url|label>`。
   - **Telegram:** HTML 標籤 (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`)。
   - **Signal:** 純文字 + `text-style` 範圍；當標籤不同時，連結變為 `label (url)`。

## IR 範例

請提供您希望翻譯的內容。

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schematic):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 使用場景

- Slack、Telegram 和 Signal 的外部適配器從 IR 渲染。
- 其他通道（WhatsApp、iMessage、MS Teams、Discord）仍然使用純文字或它們自己的格式規則，當啟用時，會在分塊之前應用 Markdown 表格轉換。

## 表格處理

Markdown 表格在各個聊天用戶端中的支援並不一致。使用 `markdown.tables` 來控制每個頻道（和每個帳戶）的轉換。

- `code`: 將表格渲染為程式碼區塊（大多數頻道的預設設定）。
- `bullets`: 將每一行轉換為專案符號（Signal + WhatsApp 的預設設定）。
- `off`: 禁用表格解析和轉換；原始表格文本直接通過。

Config keys:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Chunking rules

- Chunk 限制來自於通道適配器/設定，並應用於 IR 文字。
- 程式碼區塊會作為單一區塊保留，並帶有結尾的換行，以便通道能正確渲染它們。
- 列表前綴和引用前綴是 IR 文字的一部分，因此分塊不會在前綴中間進行拆分。
- 行內樣式（粗體/斜體/刪除線/行內程式碼/劇透）絕不會在分塊之間拆分；渲染器會在每個分塊內重新開啟樣式。

如果您需要更多有關跨通道的分塊行為，請參閱 [Streaming + chunking](/concepts/streaming)。

## Link policy

- **Slack:** `[label](url)` -> `<url|label>`; 原始網址保持原樣。自動連結在解析期間被禁用，以避免重複連結。
- **Telegram:** `[label](url)` -> `<a href="url">label</a>`（HTML 解析模式）。
- **Signal:** `[label](url)` -> `label (url)`，除非標籤與網址匹配。

## Spoilers

Spoiler 標記 (`||spoiler||`) 僅在 Signal 中被解析，並對應到 SPOILER 樣式範圍。其他頻道則將其視為普通文本。

## 如何新增或更新頻道格式化器

1. **解析一次：** 使用共享的 `markdownToIR(...)` 助手，搭配適合頻道的選項（自動連結、標題樣式、引用前綴）。
2. **渲染：** 實作一個渲染器，使用 `renderMarkdownWithMarkers(...)` 和樣式標記映射（或信號樣式範圍）。
3. **分塊：** 在渲染之前呼叫 `chunkMarkdownIR(...)`；渲染每個分塊。
4. **連接適配器：** 更新頻道的外部適配器，以使用新的分塊器和渲染器。
5. **測試：** 如果頻道使用分塊，則新增或更新格式測試和外部交付測試。

## 常見問題

- Slack 角括號標記 (`<@U123>`, `<#C123>`, `<https://...>`) 必須保留；安全地轉義原始 HTML。
- Telegram HTML 需要轉義標籤外的文本以避免標記破損。
- Signal 樣式範圍依賴於 UTF-16 偏移量；請勿使用碼點偏移量。
- 保留圍欄程式碼區塊的尾隨換行，以便結束標記能獨立於一行。
