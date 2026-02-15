---
summary: "適用於發送頻道的 Markdown 格式化流程"
read_when:
  - 當您正在更改發送頻道的 Markdown 格式化或區塊切分時
  - 當您正在新增頻道格式化器或樣式映射時
  - 當您正在排查跨頻道的格式化迴歸問題時
title: "Markdown 格式化"
---

# Markdown 格式化

OpenClaw 在渲染特定頻道的輸出之前，會將發送的 Markdown 轉換為共享的中間表示（IR）。IR 在保留原始文字完整性的同時，攜帶樣式/連結範圍（spans），以便在不同頻道間保持一致的區塊切分與渲染。

## 目標

- **一致性：** 一次解析，多個渲染器。
- **安全的區塊切分：** 在渲染前分割文字，確保行內格式不會跨區塊中斷。
- **頻道適配：** 將相同的 IR 映射到 Slack mrkdwn、Telegram HTML 和 Signal 樣式範圍，無需重新解析 Markdown。

## 流程

1. **解析 Markdown -> IR**
   - IR 是純文字加上樣式範圍（粗體/斜體/刪除線/程式碼/雷利）與連結範圍。
   - 偏移量使用 UTF-16 代碼單元，使 Signal 樣式範圍與其 API 保持一致。
   - 僅當頻道啟用表格轉換時，才會解析表格。
2. **切分 IR（格式優先）**
   - 區塊切分在渲染前的 IR 文字上進行。
   - 行內格式不會跨區塊分割；範圍會依據區塊進行切割。
3. **按頻道渲染**
   - **Slack：** mrkdwn 符記（粗體/斜體/刪除線/程式碼），連結格式為 `<url|label>`。
   - **Telegram：** HTML 標籤（`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`）。
   - **Signal：** 純文字 + `text-style` 範圍；當標籤不同時，連結變為 `label (url)`。

## IR 範例

輸入 Markdown：

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (示意圖)：

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 使用場景

- Slack、Telegram 和 Signal 的發送轉接器從 IR 進行渲染。
- 其他頻道（WhatsApp、iMessage、MS Teams、Discord）仍使用純文字或其自身的格式化規則，若啟用 Markdown 表格轉換，則會在區塊切分前套用。

## 表格處理

Markdown 表格在不同的通訊軟體中支援程度不一。使用 `markdown.tables` 來控制每個頻道（及每個帳號）的轉換方式。

- `code`：將表格渲染為程式碼區塊（大多數頻道的預設值）。
- `bullets`：將每一列轉換為項目符號（Signal + WhatsApp 的預設值）。
- `off`：停用表格解析與轉換；原始表格文字將直接傳遞。

設定鍵名：

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

## 切分規則

- 區塊限制來自頻道轉接器/設定，並套用於 IR 文字。
- 程式碼圍欄（Code fences）被保留為單個區塊，並帶有結尾換行符，以便頻道正確渲染。
- 清單前綴和區塊引用前綴是 IR 文字的一部分，因此區塊切分不會從前綴中間斷開。
- 行內樣式（粗體/斜體/刪除線/行內程式碼/雷利）永遠不會跨區塊分割；渲染器會在每個區塊內重新開啟樣式。

如果您需要更多關於跨頻道區塊切分行為的資訊，請參閱 [串流傳輸 + 區塊切分（Streaming + chunking）](/concepts/streaming)。

## 連結策略

- **Slack：** `[label](url)` -> `<url|label>`；裸網址保持原樣。解析期間會停用自動連結以避免重複連結。
- **Telegram：** `[label](url)` -> `<a href="url">label</a>`（HTML 解析模式）。
- **Signal：** `[label](url)` -> `label (url)`，除非標籤與 URL 相同。

## 雷利

雷利標記（`||spoiler||`）僅針對 Signal 進行解析，並映射到 SPOILER 樣式範圍。其他頻道將其視為純文字。

## 如何新增或更新頻道格式化器

1. **解析一次：** 使用共享的 `markdownToIR(...)` 輔助函式，並配合適合頻道的選項（自動連結、標題樣式、區塊引用前綴）。
2. **渲染：** 使用 `renderMarkdownWithMarkers(...)` 和樣式標記映射（或 Signal 樣式範圍）來實作渲染器。
3. **切分：** 在渲染前呼叫 `chunkMarkdownIR(...)`；渲染每個區塊。
4. **連接轉接器：** 更新頻道的發送轉接器以使用新的切分器和渲染器。
5. **測試：** 如果頻道使用區塊切分，請新增或更新格式測試以及發送測試。

## 常見陷阱

- Slack 的角括號符記（`< @U123>`、`<#C123>`、`<https://...>`）必須保留；請安全地逸出原始 HTML。
- Telegram HTML 需要對標籤外的文字進行逸出，以避免標記失效。
- Signal 樣式範圍依賴於 UTF-16 偏移量；請勿使用代碼點（code point）偏移量。
- 保留圍欄程式碼區塊的結尾換行符，以便結束標記落在獨立的一行。
