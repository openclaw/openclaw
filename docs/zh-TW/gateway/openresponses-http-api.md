---
summary: "從 Gateway 公開一個相容於 OpenResponses 的 /v1/responses HTTP 端點"
read_when:
  - 整合支援 OpenResponses API 的用戶端
  - 您需要基於項目的輸入、用戶端工具呼叫或 SSE 事件
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw 的 Gateway 可以提供一個相容於 OpenResponses 的 `POST /v1/responses` 端點。

此端點**預設為停用**。請先在設定中啟用。

- `POST /v1/responses`
- 與 Gateway 相同的連接埠（WS + HTTP 多路復用）：`http://<gateway-host>:<port>/v1/responses`

在底層，請求會作為正常的 Gateway 智慧代理執行（與 `openclaw agent` 相同的程式路徑），因此路由、權限和設定皆與您的 Gateway 一致。

## 身份驗證

使用 Gateway 的驗證設定。請發送 Bearer 權杖：

- `Authorization: Bearer <token>`

注意事項：

- 當 `gateway.auth.mode="token"` 時，請使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 當 `gateway.auth.mode="password"` 時，請使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。
- 如果設定了 `gateway.auth.rateLimit` 且發生過多驗證失敗，端點將傳回 `429` 並附帶 `Retry-After`。

## 選擇智慧代理

不需自訂標頭：在 OpenResponses 的 `model` 欄位中編碼智慧代理 ID：

- `model: "openclaw:<agentId>"`（例如：`"openclaw:main"`, `"openclaw:beta"`）
- `model: "agent:<agentId>"`（別名）

或者透過標頭指定特定的 OpenClaw 智慧代理：

- `x-openclaw-agent-id: <agentId>`（預設：`main`）

進階：

- `x-openclaw-session-key: <sessionKey>` 以完全控制工作階段路由。

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

## 工作階段行為

預設情況下，此端點對每個請求都是**無狀態的**（每次呼叫都會產生新的工作階段金鑰）。

如果請求包含 OpenResponses 的 `user` 字串，Gateway 會從中衍生出一個穩定的工作階段金鑰，因此重複呼叫可以共用同一個智慧代理工作階段。

## 請求格式（支援的）

請求遵循 OpenResponses API，採用基於項目的輸入。目前支援：

- `input`：字串或項目物件陣列。
- `instructions`：合併至系統提示詞。
- `tools`：用戶端工具定義（函式工具）。
- `tool_choice`：篩選或要求特定的用戶端工具。
- `stream`：啟用 SSE 串流傳輸。
- `max_output_tokens`：盡力而為的輸出限制（取決於供應商）。
- `user`：穩定的工作階段路由。

已接受但**目前被忽略**：

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## 項目 (input)

### `message`

角色：`system`, `developer`, `user`, `assistant`。

- `system` 和 `developer` 會附加到系統提示詞。
- 最近的 `user` 或 `function_call_output` 項目將成為「當前訊息」。
- 較早的 user/assistant 訊息將作為歷史記錄包含在內容中。

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

為了結構相容性而接受，但在建立提示詞時會被忽略。

## 工具（用戶端函式工具）

使用 `tools: [{ type: "function", function: { name, description?, parameters? } }]` 提供工具。

如果智慧代理決定呼叫工具，回應將傳回 `function_call` 輸出項目。接著您需要發送帶有 `function_call_output` 的後續請求以繼續該回合。

## 圖片 (`input_image`)

支援 base64 或 URL 來源：

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

允許的 MIME 類型（目前）：`image/jpeg`, `image/png`, `image/gif`, `image/webp`。
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

允許的 MIME 類型（目前）：`text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/pdf`。

最大大小（目前）：5MB。

目前行為：

- 檔案內容會被解碼並加入到**系統提示詞**，而非使用者訊息，因此它是暫時性的（不會持久化在工作階段歷史記錄中）。
- PDF 會進行文字解析。如果找不到足夠的文字，第一頁將被點陣化為圖片並傳遞給模型。

PDF 解析使用 Node 友善的 `pdfjs-dist` 傳統版本（無 worker）。現代的 PDF.js 版本需要瀏覽器 worker/DOM 全域變數，因此在 Gateway 中不使用。

URL 擷取預設值：

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- `maxUrlParts`: `8`（每個請求中基於 URL 的 `input_file` + `input_image` 總部分數）
- 請求受到保護（DNS 解析、私有 IP 封鎖、重導向限制、逾時）。
- 每種輸入類型支援選用的主機名稱允許清單（`files.urlAllowlist`, `images.urlAllowlist`）。
  - 精確主機：`"cdn.example.com"`
  - 萬用字元子網域：`"*.assets.example.com"`（不符合頂層網域）

## 檔案 + 圖片限制（設定）

預設值可以在 `gateway.http.endpoints.responses` 下進行調整：

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

未指定時的預設值：

- `maxBodyBytes`: 20MB
- `maxUrlParts`: 8
- `files.maxBytes`: 5MB
- `files.maxChars`: 200,000
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10,000 (10秒)
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10,000 (10秒)

安全性注意事項：

- URL 允許清單會在擷取前以及重導向跳轉時強制執行。
- 將主機名稱加入允許清單並不會繞過私有/內部 IP 封鎖。
- 對於暴露在網際網路上的 Gateway，除了應用程式層級的防護外，請另外套用網路出口控制。請參閱 [安全性](/gateway/security)。

## 串流傳輸 (SSE)

將 `stream: true` 設定為接收伺服器傳送事件 (SSE)：

- `Content-Type: text/event-stream`
- 每個事件行均為 `event: <type>` 和 `data: <json>`
- 串流以 `data: [DONE]` 結束

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
- `response.failed`（發生錯誤時）

## 用量

當底層供應商回報權杖數量時，會填充 `usage`。

## 錯誤

錯誤使用如下的 JSON 物件：

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

常見案例：

- `401` 缺少或無效的身份驗證
- `400` 無效的請求本文
- `405` 錯誤的方法

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
