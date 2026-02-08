---
summary: "從 Gateway 暴露相容 OpenResponses 的 /v1/responses HTTP 端點"
read_when:
  - 整合使用 OpenResponses API 的用戶端
  - 你需要以項目為基礎的輸入、用戶端工具呼叫，或 SSE 事件
title: "OpenResponses API"
x-i18n:
  source_path: gateway/openresponses-http-api.md
  source_hash: 0597714837f8b210
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:12Z
---

# OpenResponses API（HTTP）

OpenClaw 的 Gateway 閘道器可以提供一個相容 OpenResponses 的 `POST /v1/responses` 端點。

此端點 **預設為停用**。請先在設定中啟用。

- `POST /v1/responses`
- 與 Gateway 閘道器相同的連接埠（WS + HTTP 多工）：`http://<gateway-host>:<port>/v1/responses`

在底層，請求會以一般的 Gateway 代理程式執行方式來處理（與
`openclaw agent` 使用相同的程式碼路徑），因此路由、權限與設定都會符合你的 Gateway 閘道器。

## 身分驗證

使用 Gateway 的身分驗證設定。請傳送 bearer token：

- `Authorization: Bearer <token>`

注意事項：

- 當 `gateway.auth.mode="token"` 時，請使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 當 `gateway.auth.mode="password"` 時，請使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。

## 選擇代理程式

不需要自訂標頭：請在 OpenResponses 的 `model` 欄位中編碼代理程式 ID：

- `model: "openclaw:<agentId>"`（範例：`"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（別名）

或者，透過標頭指定特定的 OpenClaw 代理程式：

- `x-openclaw-agent-id: <agentId>`（預設：`main`）

進階：

- `x-openclaw-session-key: <sessionKey>` 以完全控制工作階段路由。

## 啟用端點

將 `gateway.http.endpoints.responses.enabled` 設為 `true`：

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

將 `gateway.http.endpoints.responses.enabled` 設為 `false`：

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

## 工作階段行為

預設情況下，此端點 **每個請求皆為無狀態**（每次呼叫都會產生新的工作階段金鑰）。

如果請求包含 OpenResponses 的 `user` 字串，Gateway 閘道器會從該值推導出穩定的工作階段金鑰，
讓重複呼叫可以共用同一個代理程式工作階段。

## 請求結構（支援）

請求遵循 OpenResponses API，並使用以項目為基礎的輸入。目前支援：

- `input`：字串或項目物件陣列。
- `instructions`：合併到系統提示中。
- `tools`：用戶端工具定義（函式工具）。
- `tool_choice`：篩選或要求用戶端工具。
- `stream`：啟用 SSE 串流。
- `max_output_tokens`：最佳化嘗試的輸出上限（取決於提供者）。
- `user`：穩定的工作階段路由。

可接受但 **目前會被忽略**：

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## 項目（輸入）

### `message`

角色：`system`、`developer`、`user`、`assistant`。

- `system` 與 `developer` 會附加到系統提示中。
- 最近的 `user` 或 `function_call_output` 項目會成為「目前訊息」。
- 較早的使用者／助理訊息會作為歷史內容納入上下文。

### `function_call_output`（回合制工具）

將工具結果回傳給模型：

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` 與 `item_reference`

為了結構相容性而接受，但在建立提示時會被忽略。

## 工具（用戶端函式工具）

使用 `tools: [{ type: "function", function: { name, description?, parameters? } }]` 提供工具。

如果代理程式決定呼叫某個工具，回應會回傳一個 `function_call` 輸出項目。
接著你需要傳送一個包含 `function_call_output` 的後續請求，以繼續該回合。

## 圖片（`input_image`）

支援 base64 或 URL 來源：

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

允許的 MIME 類型（目前）：`image/jpeg`、`image/png`、`image/gif`、`image/webp`。
最大大小（目前）：10MB。

## 檔案（`input_file`）

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

允許的 MIME 類型（目前）：`text/plain`、`text/markdown`、`text/html`、`text/csv`、
`application/json`、`application/pdf`。

最大大小（目前）：5MB。

目前行為：

- 檔案內容會被解碼並加入 **系統提示**，而不是使用者訊息，
  因此其內容是暫時性的（不會持久化到工作階段歷史中）。
- PDF 會被解析為文字。如果找到的文字很少，則會將前幾頁轉換為影像，
  並傳遞給模型。

PDF 解析使用對 Node 友善的 `pdfjs-dist` 舊版建置（不使用 worker）。較新的
PDF.js 建置需要瀏覽器 worker／DOM 全域物件，因此未在 Gateway 閘道器中使用。

URL 擷取預設值：

- `files.allowUrl`：`true`
- `images.allowUrl`：`true`
- 請求具備防護（DNS 解析、私有 IP 封鎖、重新導向上限、逾時）。

## 檔案與圖片限制（設定）

預設值可在 `gateway.http.endpoints.responses` 下調整：

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
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

省略時的預設值：

- `maxBodyBytes`：20MB
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

## 串流（SSE）

設定 `stream: true` 以接收 Server-Sent Events（SSE）：

- `Content-Type: text/event-stream`
- 每一行事件為 `event: <type>` 與 `data: <json>`
- 串流以 `data: [DONE]` 結束

目前會發送的事件類型：

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`（發生錯誤時）

## 使用量

當底層提供者回報權杖計數時，會填入 `usage`。

## 錯誤

錯誤會使用如下的 JSON 物件：

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

常見情況：

- `401` 缺少／無效的身分驗證
- `400` 無效的請求內容
- `405` 錯誤的 HTTP 方法

## 範例

非串流：

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

串流：

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
