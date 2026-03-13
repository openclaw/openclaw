---
summary: Markdown formatting pipeline for outbound channels
read_when:
  - You are changing markdown formatting or chunking for outbound channels
  - You are adding a new channel formatter or style mapping
  - You are debugging formatting regressions across channels
title: Markdown Formatting
---

# Markdown 格式化

OpenClaw 透過將輸出的 Markdown 轉換成共用的中介表示法（IR）來格式化，然後再渲染成特定頻道的輸出。IR 保留原始文字不變，同時攜帶樣式/連結範圍，讓分段與渲染在各頻道間保持一致。

## 目標

- **一致性：** 一次解析，多個渲染器。
- **安全分段：** 在渲染前切分文字，確保內嵌格式不會跨段斷裂。
- **頻道適配：** 將相同 IR 映射到 Slack mrkdwn、Telegram HTML 和 Signal 樣式範圍，無需重新解析 Markdown。

## 流程

1. **解析 Markdown -> IR**
   - IR 是純文字加上樣式範圍（粗體/斜體/刪除線/程式碼/隱藏）及連結範圍。
   - 偏移量以 UTF-16 編碼單元計算，讓 Signal 樣式範圍與其 API 對齊。
   - 只有當頻道選擇啟用表格轉換時，才會解析表格。
2. **分段 IR（先格式化）**
   - 分段在渲染前於 IR 文字上進行。
   - 內嵌格式不會跨段切割；範圍會依段落切割。
3. **依頻道渲染**
   - **Slack：** mrkdwn 標記（粗體/斜體/刪除線/程式碼），連結以 `<url|label>` 表示。
   - **Telegram：** HTML 標籤 (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`)。
   - **Signal：** 純文字 + `text-style` 範圍；當標籤不同時，連結轉為 `label (url)`。

## IR 範例

輸入 Markdown：

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR（示意）：

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 使用場景

- Slack、Telegram 和 Signal 的輸出適配器皆從 IR 渲染。
- 其他頻道（WhatsApp、iMessage、MS Teams、Discord）仍使用純文字或自有格式規則，啟用時會在分段前套用 Markdown 表格轉換。

## 表格處理

Markdown 表格在各聊天用戶端支援不一。可使用 `markdown.tables` 來控制各頻道（及帳號）是否轉換。

- `code`：將表格渲染為程式碼區塊（大多數頻道的預設）。
- `bullets`：將每一列轉換為專案符號清單（Signal 與 WhatsApp 的預設）。
- `off`：停用表格解析與轉換；原始表格文字直接通過。

設定鍵：

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

## 分塊規則

- 分塊限制來自頻道適配器/設定，並套用於 IR 文字。
- 程式碼區塊會保留為單一區塊，並附帶尾端換行，以確保頻道正確渲染。
- 清單前綴與引用區塊前綴是 IR 文字的一部分，因此分塊不會在前綴中間切割。
- 內嵌樣式（粗體/斜體/刪除線/內嵌程式碼/劇透）絕不會跨分塊切割；渲染器會在每個分塊內重新開啟樣式。

若需更多關於跨頻道分塊行為的資訊，請參考
[串流 + 分塊](/concepts/streaming)。

## 連結政策

- **Slack：** `[label](url)` -> `<url|label>`；裸露 URL 保持裸露。解析時停用自動連結以避免重複連結。
- **Telegram：** `[label](url)` -> `<a href="url">label</a>`（HTML 解析模式）。
- **Signal：** `[label](url)` -> `label (url)`，除非標籤與 URL 相符。

## 劇透標記

劇透標記 (`||spoiler||`) 僅於 Signal 解析，映射為 SPOILER 樣式範圍。其他頻道視為純文字。

## 如何新增或更新頻道格式化器

1. **解析一次：** 使用共用的 `markdownToIR(...)` 輔助函式，搭配頻道適用的選項（自動連結、標題樣式、引用區塊前綴）。
2. **渲染：** 實作帶有 `renderMarkdownWithMarkers(...)` 與樣式標記映射（或 Signal 樣式範圍）的渲染器。
3. **分塊：** 在渲染前呼叫 `chunkMarkdownIR(...)`；對每個分塊進行渲染。
4. **連接適配器：** 更新頻道出站適配器以使用新的分塊器與渲染器。
5. **測試：** 新增或更新格式測試，若頻道使用分塊，則新增出站傳送測試。

## 常見陷阱

- Slack 角括號標記 (`<@U123>`、`<#C123>`、`<https://...>`) 必須保留；安全地轉義原始 HTML。
- Telegram HTML 需轉義標籤外的文字，以避免標記錯亂。
- Signal 樣式範圍依賴 UTF-16 偏移量；不可使用碼點偏移量。
- 保留程式碼區塊尾端換行，確保結束標記獨立成行。
