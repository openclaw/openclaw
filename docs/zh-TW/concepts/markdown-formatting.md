---
summary: "用於出站頻道之 Markdown 格式化流程"
read_when:
  - 您正在變更出站頻道的 Markdown 格式或區塊化設定
  - 您正在新增頻道格式化工具或樣式對應
  - 您正在偵錯跨頻道的格式化迴歸問題
title: "Markdown 格式化"
---

# Markdown 格式化

OpenClaw 會將出站 Markdown 轉換成共享的中介表示 (IR)，然後再呈現特定頻道的輸出。IR 會保留原始文字，同時攜帶樣式/連結範圍，以便區塊化和呈現能跨頻道保持一致。

## 目標

- **一致性**：一次解析步驟，多個呈現器。
- **安全區塊化**：在呈現之前分割文字，以便內聯格式永遠不會跨區塊中斷。
- **符合頻道**：將相同的 IR 對應到 Slack mrkdwn、Telegram HTML 和 Signal 樣式範圍，無需重新解析 Markdown。

## 流程

1.  **解析 Markdown -> IR**
    - IR 是純文字加上樣式範圍（粗體/斜體/刪除線/程式碼/劇透）和連結範圍。
    - 偏移量是 UTF-16 程式碼單元，因此 Signal 樣式範圍與其 API 對齊。
    - 僅當頻道選擇啟用表格轉換時，才會解析表格。
2.  **區塊化 IR（格式優先）**
    - 區塊化發生在呈現之前的 IR 文字上。
    - 內聯格式不會跨區塊分割；範圍會依每個區塊進行切片。
3.  **依頻道呈現**
    - **Slack**：mrkdwn 權杖（粗體/斜體/刪除線/程式碼），連結為 `<url|label>`。
    - **Telegram**：HTML 標籤（`<b>`、`<i>`、`<s>`、`<code>`、`<pre><code>`、`<a href>`）。
    - **Signal**：純文字 + `text-style` 範圍；當標籤不同時，連結會變成 `label (url)`。

## IR 範例

輸入 Markdown：

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR（示意圖）：

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 用途

- Slack、Telegram 和 Signal 出站轉接器從 IR 呈現。
- 其他頻道 (WhatsApp、iMessage、MS Teams、Discord) 仍然使用純文字或其自己的格式規則，並在啟用時於區塊化之前套用 Markdown 表格轉換。

## 表格處理

Markdown 表格在聊天用戶端之間支援不一致。使用 `markdown.tables` 可控制每個頻道（和每個帳戶）的轉換。

- `code`：將表格呈現為程式碼區塊（大多數頻道的預設）。
- `bullets`：將每列轉換為項目符號（Signal + WhatsApp 的預設）。
- `off`：停用表格解析和轉換；原始表格文字會直接通過。

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

## 區塊化規則

- 區塊限制來自頻道轉接器/設定，並套用到 IR 文字。
- 程式碼區塊保留為單一區塊，帶有結尾換行符，以便頻道正確呈現它們。
- 列表前綴和引言前綴是 IR 文字的一部分，因此區塊化不會在中間分割前綴。
- 內聯樣式（粗體/斜體/刪除線/內聯程式碼/劇透）永遠不會跨區塊分割；呈現器會在每個區塊內重新開啟樣式。

如果您需要更多關於跨頻道區塊化行為的資訊，請參閱 [Streaming + chunking](/concepts/streaming)。

## 連結政策

- **Slack**：`[label](url)` -> `<url|label>`；裸 URL 保持裸露。解析期間會停用自動連結以避免雙重連結。
- **Telegram**：`[label](url)` -> `<a href="url">label</a>` (HTML 解析模式)。
- **Signal**：`[label](url)` -> `label (url)`，除非標籤與 URL 匹配。

## 劇透

劇透標記 (`||spoiler||`) 僅針對 Signal 進行解析，其中它們會對應到 SPOILER 樣式範圍。其他頻道會將它們視為純文字。

## 如何新增或更新頻道格式化工具

1.  **解析一次**：使用共享的 `markdownToIR(...)` 輔助工具，並帶有適合頻道的選項（自動連結、標題樣式、引言前綴）。
2.  **呈現**：使用 `renderMarkdownWithMarkers(...)` 和樣式標記映射（或 Signal 樣式範圍）實作呈現器。
3.  **區塊化**：在呈現之前呼叫 `chunkMarkdownIR(...)`；呈現每個區塊。
4.  **連接轉接器**：更新頻道出站轉接器以使用新的區塊化工具和呈現器。
5.  **測試**：新增或更新格式測試和出站交付測試，如果頻道使用區塊化。

## 常見陷阱

- Slack 角括號權杖（`< @U123>`、`<#C123>`、`<https://...>`）必須保留；安全地逸出原始 HTML。
- Telegram HTML 需要逸出標籤外的文字以避免損壞的標記。
- Signal 樣式範圍取決於 UTF-16 偏移量；不要使用程式碼點偏移量。
- 保留柵欄程式碼區塊的結尾換行符，以便關閉標記落在自己的行上。
