---
summary: "從 Gateway公開相容 OpenResponses 的 /v1/responses HTTP 端點"
read_when:
  - 整合使用 OpenResponses API 的客戶端
  - 您需要基於項目的輸入、客戶端工具呼叫或 SSE 事件
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw 的 Gateway 可以提供相容 OpenResponses 的 `POST /v1/responses` 端點。

此端點**預設為停用**。請先在 設定 中啟用它。

- `POST /v1/responses`
- 與 Gateway 相同的連接埠 (WS + HTTP 多工)：`http://<gateway-host>:<port>/v1/responses`

在底層，請求會作為正常的 Gateway 智慧代理 執行（與 `openclaw agent` 相同的程式碼路徑），因此路由/權限/設定 與您的 Gateway 相符。

## 憑證

使用 Gateway 憑證 設定。傳送 bearer token：

- `Authorization: Bearer <token>`

注意事項：

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。
- 如果設定了 `gateway.auth.rateLimit` 且發生過多的憑證失敗，端點將返回 `429` 並帶有 `Retry-After`。

## 選擇智慧代理

無需自訂標頭：將 智慧代理 ID 編碼在 OpenResponses `model` 欄位中：

- `model: "openclaw:<agentId>"`（範例：`"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（別名）

或者透過標頭指定特定的 OpenClaw 智慧代理：

- `x-openclaw-agent-id: <agentId>`（預設：`main`）

進階：

- `x-openclaw-session-key: <sessionKey>` 以完全控制 工作階段 路由。

## 啟用端點

將 `gateway.http.endpoints.responses.enabled` 設定為 `true`：

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## 停用端點

將 `gateway.http.endpoints.responses.enabled` 設定為 `false`：

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## 工作階段 行為

預設情況下，此端點**每個請求都是無狀態的**（每次呼叫都會產生新的 工作階段 鍵）。

如果請求包含 OpenResponses `user` 字串，Gateway 會從中衍生出一個穩定的 工作階段 鍵，因此重複呼叫可以共用一個 智慧代理 工作階段。

## 請求結構（支援的）

請求遵循 OpenResponses API，採用基於項目的輸入。目前支援：

- `input`：字串或項目物件陣列。
- `instructions`：合併到系統提示中。
- `tools`：客戶端 工具 定義（函數 工具）。
- `tool_choice`：篩選或要求客戶端 工具。
- `stream`：啟用 SSE 串流傳輸。
- `max_output_tokens`：盡力而為的輸出限制（依據 供應商 而定）。
- `user`：穩定的 工作階段 路由。

接受但**目前忽略**：

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## 項目 (輸入)

### `message`

角色：`system`、`developer`、`user`、`assistant`。

- `system` 和 `developer` 會附加到系統提示中。
- 最近的 `user` 或 `function_call_output` 項目會成為「目前 訊息」。
- 較早的 user/assistant 訊息 會作為歷史 資訊 包含在內以提供上下文。

### `function_call_output` (基於回合的 工具)

將 工具 結果傳回 模型：

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` 和 `item_reference`

為模式相容性而接受，但在建構提示時會忽略。

## 工具 (客戶端函數 工具)

使用 `tools: [{ type: "function", function: { name, description?, parameters? } }]` 提供 工具。

如果 智慧代理 決定呼叫 工具，響應會返回一個 `function_call` 輸出項目。然後您發送一個帶有 `function_call_output` 的後續請求以繼續該回合。

## 圖像 (`input_image`)

支援 base64 或 URL 來源：

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

允許的 MIME 類型（目前）：`image/jpeg`、`image/png`、`image/gif`、`image/webp`。
最大大小（目前）：10MB。

## 檔案 (`input_file`)

支援 base64 或 URL 來源：

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

允許的 MIME 類型（目前）：`text/plain`、`text/markdown`、`text/html`、`text/csv`、`application/json`、`application/pdf`。

最大大小（目前）：5MB。

目前行為：

- 檔案 內容會被解碼並新增到**系統提示**中，而不是使用者 訊息，因此它是短暫的（不會在 工作階段 歷史中持久化）。
- PDF 會被解析以提取文字。如果文字很少，則會將前幾頁光柵化為圖像並傳遞給 模型。

PDF 解析使用 Node 友善的 `pdfjs-dist` 傳統建構（無 worker）。現代 PDF.js 建構需要瀏覽器 worker/DOM 全域變數，因此不會在 Gateway 中使用。

URL 擷取 預設 值：

- `files.allowUrl`：`true`
- `images.allowUrl`：`true`
- `maxUrlParts`: `8` (每個請求中基於 URL 的 `input_file` + `input_image` 部分總數)
- 請求受到防護（DNS 解析、私有 IP 阻擋、重新導向限制、逾時）。
- 每個輸入類型都支援可選的主機名稱允許列表（`files.urlAllowlist`、`images.urlAllowlist`）。
  - 精確主機：`"cdn.example.com"`
  - 萬用字元子網域：`"*.assets.example.com"`（不匹配頂級網域）

## 檔案 + 圖像限制 (設定)

可以在 `gateway.http.endpoints.responses` 下調整 預設 值：

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            urlAllowlist: ["images.example.com"],
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

省略時的 預設 值：

- `maxBodyBytes`：20MB
- `maxUrlParts`：8
- `files.maxBytes`：5MB
- `files.maxChars`：200k
- `files.maxRedirects`：3
- `files.timeoutMs`：10s
- `files.pdf.maxPages`：4
- `files.pdf.maxPixels`：4,000,000
- `files.pdf.minTextChars`：200
- `images.maxBytes`：10MB
- `images.maxRedirects`：3
- `images.timeoutMs`：10s

安全注意事項：

- URL 允許列表在擷取之前和重新導向跳轉時強制執行。
- 將主機名稱列入允許列表並不會繞過私人/內部 IP 阻擋。
- 對於暴露於網際網路的 Gateway，除了應用程式層級的防護外，還要實施 網路 出口控制。請參閱 [Security](/gateway/security)。

## 串流傳輸 (SSE)

將 `stream: true` 設定為接收 Server-Sent Events (SSE)：

- `Content-Type: text/event-stream`
- 每個事件行都是 `event: <type>` 和 `data: <json>`
- 串流 以 `data: [DONE]` 結束

目前發出的事件類型：

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (出錯時)

## 用量

當底層 供應商 報告 token 計數時，`usage` 會被填充。

## 錯誤

錯誤使用類似以下的 JSON 物件：

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

常見情況：

- `401` 缺少/無效的憑證
- `400` 無效的請求主體
- `405` 錯誤的方法

## 範例

非串流傳輸：

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

串流傳輸：

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
