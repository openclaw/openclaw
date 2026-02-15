---
summary: "從 Gateway暴露與 OpenAI 相容的 /v1/chat/completions HTTP 端點"
read_when:
  - 整合預期使用 OpenAI Chat Completions 的工具時
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw 的 Gateway可以提供一個小型的 OpenAI 相容 Chat Completions 端點。

此端點**預設為停用**。請先在設定中啟用它。

- `POST /v1/chat/completions`
- 與 Gateway使用相同連接埠 (WS + HTTP 多工)：`http://<gateway-host>:<port>/v1/chat/completions`

在底層，請求會作為一般的 Gateway智慧代理執行 (與 `openclaw agent` 相同的程式碼路徑)，因此路由/權限/設定與您的 Gateway相符。

## 憑證

使用 Gateway憑證設定。發送一個 Bearer 權杖：

- `Authorization: Bearer <token>`

注意事項：

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password` (或 `OPENCLAW_GATEWAY_PASSWORD`)。
- 如果 `gateway.auth.rateLimit` 已設定且發生過多的憑證失敗，此端點會回傳 `429` 並附帶 `Retry-After`。

## 選擇智慧代理

無需自訂標頭：將智慧代理 ID 編碼到 OpenAI `model` 欄位中：

- `model: "openclaw:<agentId>"` (範例：`"openclaw:main"`、`"openclaw:beta"`)
- `model: "agent:<agentId>"` (別名)

或透過標頭指定特定的 OpenClaw 智慧代理：

- `x-openclaw-agent-id: <agentId>` (預設值：`main`)

進階：

- `x-openclaw-session-key: <sessionKey>` 以完全控制工作階段路由。

## 啟用端點

將 `gateway.http.endpoints.chatCompletions.enabled` 設定為 `true`：

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## 停用端點

將 `gateway.http.endpoints.chatCompletions.enabled` 設定為 `false`：

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## 工作階段行為

預設情況下，此端點是**每個請求無狀態**的 (每次呼叫都會生成一個新的工作階段金鑰)。

如果請求包含 OpenAI `user` 字串，Gateway會從中派生出一個穩定的工作階段金鑰，因此重複的呼叫可以共享智慧代理工作階段。

## 串流 (SSE)

將 `stream: true` 設定為接收伺服器傳送事件 (SSE)：

- `Content-Type: text/event-stream`
- 每個事件行都是 `data: <json>`
- 串流以 `data: [DONE]` 結束

## 範例

非串流：

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

串流：

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
