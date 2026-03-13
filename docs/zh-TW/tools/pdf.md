---
title: PDF Tool
summary: >-
  Analyze one or more PDF documents with native provider support and extraction
  fallback
read_when:
  - You want to analyze PDFs from agents
  - You need exact pdf tool parameters and limits
  - You are debugging native PDF mode vs extraction fallback
---

# PDF 工具

`pdf` 會分析一個或多個 PDF 文件並回傳文字內容。

快速行為說明：

- Anthropic 和 Google 模型提供者的原生提供者模式。
- 其他提供者的擷取備援模式（先擷取文字，必要時再擷取頁面圖片）。
- 支援單一 (`pdf`) 或多重 (`pdfs`) 輸入，每次最多 10 個 PDF。

## 可用性

此工具僅在 OpenClaw 能為代理解析出具備 PDF 功能的模型設定時註冊：

1. `agents.defaults.pdfModel`
2. 備援至 `agents.defaults.imageModel`
3. 根據可用授權備援至最佳努力提供者預設值

若無法解析出可用模型，則不會暴露 `pdf` 工具。

## 輸入參考

- `pdf` (`string`)：單一 PDF 路徑或 URL
- `pdfs` (`string[]`)：多個 PDF 路徑或 URL，最多 10 個
- `prompt` (`string`)：分析提示，預設為 `Analyze this PDF document.`
- `pages` (`string`)：頁面篩選，如 `1-5` 或 `1,3,7-9`
- `model` (`string`)：可選模型覆寫 (`provider/model`)
- `maxBytesMb` (`number`)：每個 PDF 的大小上限（MB）

輸入說明：

- `pdf` 與 `pdfs` 會合併並去重後再載入。
- 若未提供 PDF 輸入，工具會報錯。
- `pages` 會被解析為從 1 開始的頁碼，去重、排序，並限制在設定的最大頁數內。
- `maxBytesMb` 預設為 `agents.defaults.pdfMaxBytesMb` 或 `10`。

## 支援的 PDF 參考方式

- 本地檔案路徑（包含 `~` 展開）
- `file://` URL
- `http://` 與 `https://` URL

參考說明：

- 其他 URI 協議（例如 `ftp://`）會被 `unsupported_pdf_reference` 拒絕。
- 在沙盒模式下，遠端 `http(s)` URL 會被拒絕。
- 啟用僅限工作區檔案政策時，允許根目錄外的本地檔案路徑會被拒絕。

## 執行模式

### 原生提供者模式

原生模式用於提供者 `anthropic` 和 `google`。
工具會將原始 PDF 位元組直接傳送到提供者 API。

原生模式限制：

- 不支援 `pages`。若設定此項，工具會回傳錯誤。

### 擷取備援模式

備援模式用於非原生提供者。

流程：

1. 從選取的頁面擷取文字（最多 `agents.defaults.pdfMaxPages` 頁，預設 `20` 頁）。
2. 若擷取文字長度低於 `200` 字元，則將選取頁面渲染成 PNG 圖像並包含在內。
3. 將擷取的內容加上提示詞傳送給選定的模型。

備援細節：

- 頁面圖像擷取使用 `4,000,000` 像素預算。
- 若目標模型不支援圖像輸入且無法擷取文字，工具會回傳錯誤。
- 擷取備援需要 `pdfjs-dist`（以及用於圖像渲染的 `@napi-rs/canvas`）。

## 設定

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

完整欄位細節請參考[設定參考](/gateway/configuration-reference)。

## 輸出細節

工具會回傳 `content[0].text` 中的文字以及 `details` 中的結構化元資料。

常見的 `details` 欄位：

- `model`：已解析的模型參考 (`provider/model`)
- `native`：原生提供者模式的 `true`，回退模式的 `false`
- `attempts`：成功前失敗的回退嘗試次數

路徑欄位：

- 單一 PDF 輸入：`details.pdf`
- 多個 PDF 輸入：包含 `pdf` 筆條目的 `details.pdfs[]`
- 沙盒路徑重寫元資料（如適用）：`rewrittenFrom`

## 錯誤行為

- 缺少 PDF 輸入：拋出 `pdf required: provide a path or URL to a PDF document`
- PDF 數量過多：在 `details.error = "too_many_pdfs"` 回傳結構化錯誤
- 不支援的參考方案：回傳 `details.error = "unsupported_pdf_reference"`
- 原生模式搭配 `pages`：拋出明確的 `pages is not supported with native PDF providers` 錯誤

## 範例

單一 PDF：

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

多個 PDF：

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

頁面過濾的回退模型：

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```
