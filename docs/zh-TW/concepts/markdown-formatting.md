---
summary: 「用於對外通道的 Markdown 格式化管線」
read_when:
  - 當你正在變更對外通道的 Markdown 格式化或分塊行為時
  - 當你正在新增新的通道格式化器或樣式對應時
  - 當你正在除錯跨通道的格式回歸問題時
title: 「Markdown 格式化」
x-i18n:
  source_path: concepts/markdown-formatting.md
  source_hash: f9cbf9b744f9a218
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:42Z
---

# Markdown 格式化

OpenClaw 透過先將對外的 Markdown 轉換為共用的中介表示（IR），再渲染成各通道專屬的輸出格式。IR 在保留原始文字內容的同時，攜帶樣式／連結的跨度資訊，讓分塊與渲染能在各通道間保持一致。

## 目標

- **一致性：** 一次解析，多個渲染器。
- **安全分塊：** 在渲染之前先切分文字，確保行內格式不會跨分塊被破壞。
- **通道適配：** 將相同的 IR 對應到 Slack mrkdwn、Telegram HTML 與 Signal 樣式範圍，而不需重新解析 Markdown。

## 管線流程

1. **解析 Markdown -> IR**
   - IR 是純文字加上樣式跨度（粗體／斜體／刪除線／程式碼／劇透）與連結跨度。
   - 位移量使用 UTF-16 程式碼單位，確保 Signal 樣式範圍能與其 API 對齊。
   - 表格僅在通道選擇啟用表格轉換時才會被解析。
2. **分塊 IR（先格式化）**
   - 分塊發生在渲染之前，直接作用於 IR 文字。
   - 行內格式不會跨分塊切割；跨度會依分塊被裁切。
3. **依通道渲染**
   - **Slack：** mrkdwn 標記（粗體／斜體／刪除線／程式碼），連結渲染為 `<url|label>`。
   - **Telegram：** HTML 標籤（`<b>`、`<i>`、`<s>`、`<code>`、`<pre><code>`、`<a href>`）。
   - **Signal：** 純文字 + `text-style` 範圍；當標籤與 URL 不同時，連結會變成 `label (url)`。

## IR 範例

輸入的 Markdown：

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

## 使用位置

- Slack、Telegram 與 Signal 的對外適配器皆從 IR 進行渲染。
- 其他通道（WhatsApp、iMessage、MS Teams、Discord）仍使用純文字或各自的格式規則；當啟用時，Markdown 表格轉換會在分塊之前套用。

## 表格處理

Markdown 表格在各聊天客戶端中的支援並不一致。請使用
`markdown.tables` 來控制各通道（以及各帳戶）的轉換行為。

- `code`：將表格渲染為程式碼區塊（多數通道的預設）。
- `bullets`：將每一列轉換為項目符號清單（Signal + WhatsApp 的預設）。
- `off`：停用表格解析與轉換；原始表格文字直接傳遞。

設定金鑰：

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

- 分塊上限來自通道適配器／設定，並套用於 IR 文字。
- 程式碼圍欄會以單一區塊保留，並包含結尾換行，確保通道能正確渲染。
- 清單前綴與引用區塊前綴屬於 IR 文字的一部分，因此分塊不會在前綴中途切割。
- 行內樣式（粗體／斜體／刪除線／行內程式碼／劇透）永遠不會跨分塊切割；渲染器會在每個分塊內重新開啟樣式。

若需要進一步了解各通道的分塊行為，請參閱
[Streaming + chunking](/concepts/streaming)。

## 連結政策

- **Slack：** `[label](url)` -> `<url|label>`；裸露 URL 保持原樣。解析時會停用自動連結，以避免重複建立連結。
- **Telegram：** `[label](url)` -> `<a href="url">label</a>`（HTML 解析模式）。
- **Signal：** `[label](url)` -> `label (url)`，除非標籤與 URL 相同。

## 劇透

劇透標記（`||spoiler||`）僅會為 Signal 進行解析，並對應到 SPOILER 樣式範圍。其他通道會將其視為純文字。

## 如何新增或更新通道格式化器

1. **只解析一次：** 使用共用的 `markdownToIR(...)` 輔助函式，並設定符合通道需求的選項（自動連結、標題樣式、引用區塊前綴）。
2. **渲染：** 以 `renderMarkdownWithMarkers(...)` 實作渲染器，並提供樣式標記對應（或 Signal 的樣式範圍）。
3. **分塊：** 在渲染之前呼叫 `chunkMarkdownIR(...)`；逐一渲染每個分塊。
4. **串接適配器：** 更新通道的對外適配器，使用新的分塊器與渲染器。
5. **測試：** 新增或更新格式測試；若該通道使用分塊，請加入對外傳送測試。

## 常見陷阱

- Slack 的角括號標記（`<@U123>`、`<#C123>`、`<https://...>`）必須被保留；請安全地跳脫原始 HTML。
- Telegram 的 HTML 需要對標籤外的文字進行跳脫，以避免標記損壞。
- Signal 的樣式範圍依賴 UTF-16 位移量；請勿使用程式碼點位移。
- 對於圍欄程式碼區塊，請保留結尾換行，確保結尾標記落在獨立的一行。
