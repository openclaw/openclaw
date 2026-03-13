---
summary: >-
  Expose an OpenResponses-compatible /v1/responses HTTP endpoint from the
  Gateway
read_when:
  - Integrating clients that speak the OpenResponses API
  - "You want item-based inputs, client tool calls, or SSE events"
title: OpenResponses API
---

# OpenResponses API (HTTP)

OpenClaw 的 Gateway 可以提供與 OpenResponses 相容的 `POST /v1/responses` 端點。

此端點預設為**禁用**。請先在設定中啟用它。

- `POST /v1/responses`
- 與閘道相同的埠 (WS + HTTP 多路復用): `http://<gateway-host>:<port>/v1/responses`

在底層，請求的執行方式與正常的 Gateway 代理執行相同（與 `openclaw agent` 的程式碼路徑相同），因此路由/權限/設定會與您的 Gateway 相符。

## 認證

使用 Gateway 認證設定。發送 bearer token：

`Authorization: Bearer <token>`

Notes:

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password` (或 `OPENCLAW_GATEWAY_PASSWORD`)。
- 如果 `gateway.auth.rateLimit` 已設定且發生過多的身份驗證失敗，端點將返回 `429` 並附帶 `Retry-After`。

## Security boundary (important)

將此端點視為網關實例的 **完整操作員訪問** 界面。

- 此處的 HTTP bearer 認證並不是一個狹隘的每位使用者範圍模型。
- 對於此端點，有效的 Gateway token/密碼應被視為擁有者/操作員的憑證。
- 請求通過與受信任操作員行動相同的控制平面代理路徑執行。
- 此端點沒有單獨的非擁有者/每位使用者的工具邊界；一旦呼叫者在此通過 Gateway 認證，OpenClaw 將該呼叫者視為此 Gateway 的受信任操作員。
- 如果目標代理政策允許使用敏感工具，則此端點可以使用它們。
- 僅將此端點保持在回環/尾網/私有入口；請勿直接將其暴露於公共互聯網。

請參閱 [Security](/gateway/security) 和 [Remote access](/gateway/remote)。

## 選擇代理人

不需要自訂標頭：將代理 ID 編碼在 OpenResponses `model` 欄位中：

- `model: "openclaw:<agentId>"` (範例: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (別名)

或透過標頭針對特定的 OpenClaw 代理進行目標設定：

- `x-openclaw-agent-id: <agentId>` (預設值: `main`)

[[BLOCK_1]]

- `x-openclaw-session-key: <sessionKey>` 以完全控制會話路由。

## 啟用端點

Set `gateway.http.endpoints.responses.enabled` to `true`:

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

Set `gateway.http.endpoints.responses.enabled` to `false`:

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

## Session behavior

預設情況下，端點是 **每個請求無狀態**（每次呼叫都會生成一個新的會話金鑰）。

如果請求包含 OpenResponses `user` 字串，閘道會從中衍生出一個穩定的會話金鑰，以便重複的呼叫可以共享一個代理會話。

## Request shape (supported)

該請求遵循 OpenResponses API，並使用基於專案的輸入。目前支援：

- `input`: 字串或專案物件的陣列。
- `instructions`: 合併到系統提示中。
- `tools`: 用戶端工具定義（功能工具）。
- `tool_choice`: 過濾或要求用戶端工具。
- `stream`: 啟用 SSE 串流。
- `max_output_tokens`: 最佳努力的輸出限制（依提供者而異）。
- `user`: 穩定的會話路由。

Accepted but **currently ignored**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (input)

### `message`

Roles: `system`, `developer`, `user`, `assistant`.

- `system` 和 `developer` 被附加到系統提示中。
- 最近的 `user` 或 `function_call_output` 專案成為「當前訊息」。
- 早期的使用者/助手訊息作為歷史記錄以提供上下文。

### `function_call_output` (回合制工具)

將工具結果發送回模型：

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` and `item_reference`

接受了架構相容性，但在建立提示時被忽略。

## 工具（用戶端功能工具）

提供工具與 `tools: [{ type: "function", function: { name, description?, parameters? } }]`。

如果代理決定呼叫一個工具，回應將返回一個 `function_call` 輸出專案。然後，您可以發送後續請求，使用 `function_call_output` 來繼續該回合。

## 圖片 (`input_image`)

支援 base64 或 URL 來源：

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

允許的 MIME 類型（目前）：`image/jpeg`、`image/png`、`image/gif`、`image/webp`、`image/heic`、`image/heif`。  
最大大小（目前）：10MB。

## Files (`input_file`)

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

Allowed MIME types (current): `text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/pdf`.

最大大小（目前）：5MB。

當前行為：

- 檔案內容被解碼並添加到 **系統提示** 中，而不是用戶訊息中，因此它保持短暫性（不會在會話歷史中持久化）。
- PDF 檔案會被解析以提取文本。如果找到的文本很少，則會將前幾頁轉換為影像並傳遞給模型。

PDF 解析使用 Node 友好的 `pdfjs-dist` 遺留版本（不使用工作者）。現代的 PDF.js 版本則需要瀏覽器工作者/DOM 全域，因此在 Gateway 中不使用它。

URL 擷取預設值：

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- `maxUrlParts`: `8` (每個請求的總 URL 基於 `input_file` + `input_image` 部分)
- 請求受到保護（DNS 解析、私有 IP 阻擋、重定向上限、超時）。
- 每種輸入類型支援可選的主機名稱白名單 (`files.urlAllowlist`, `images.urlAllowlist`)。
  - 精確主機: `"cdn.example.com"`
  - 通配符子域: `"*.assets.example.com"`（不匹配頂級域）

## 文件 + 圖像限制 (設定)

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
            allowedMimes: [
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/heic",
              "image/heif",
            ],
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

Defaults when omitted:

- `maxBodyBytes`: 20MB
- `maxUrlParts`: 8
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s
- HEIC/HEIF `input_image` 源文件會被接受並在提供者交付之前轉換為 JPEG 格式。

安全注意事項：

- URL 允許清單在取用前和重定向跳轉時會被強制執行。
- 允許清單中的主機名稱不會繞過私有/內部 IP 的封鎖。
- 對於暴露於互聯網的閘道，除了應用層的防護外，還需應用網路出口控制。
  請參見 [Security](/gateway/security)。

## Streaming (SSE)

將 `stream: true` 設定為接收伺服器傳送事件 (SSE)：

- `Content-Type: text/event-stream`
- 每個事件行是 `event: <type>` 和 `data: <json>`
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
- `response.failed` (發生錯誤)

## 使用方式

`usage` 在底層提供者報告 token 數量時被填充。

## Errors

錯誤使用 JSON 物件，如下所示：

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

[[BLOCK_1]]  
常見案例：  
[[BLOCK_1]]

- `401` 缺少/無效的認證
- `400` 無效的請求主體
- `405` 錯誤的方法

## Examples

[[BLOCK_1]]

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

[[BLOCK_1]]

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
