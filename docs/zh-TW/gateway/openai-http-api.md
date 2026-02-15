---
summary: "從 Gateway 公開一個與 OpenAI 相容的 /v1/chat/completions HTTP 端點"
read_when:
  - 整合預期使用 OpenAI Chat Completions 的工具時
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw 的 Gateway 可以提供一個小型的 OpenAI 相容 Chat Completions 端點。

此端點**預設為停用**。請先在設定中啟用。

- `POST /v1/chat/completions`
- 與 Gateway 使用相同的連接埠（WS + HTTP 多工）：`http://<gateway-host>:<port>/v1/chat/completions`

在底層，請求會作為一般的 Gateway 智慧代理運行（與 `openclaw agent` 的程式碼路徑相同），因此路由、權限和設定皆與您的 Gateway 一致。

## 驗證

使用 Gateway 的驗證設定。請傳送 Bearer Token：

- `Authorization: Bearer <token>`

備註：

- 當 `gateway.auth.mode="token"` 時，請使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 當 `gateway.auth.mode="password"` 時，請使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。
- 如果已設定 `gateway.auth.rateLimit` 且發生過多驗證失敗，端點將回傳 `429` 錯誤並附帶 `Retry-After`。

## 選擇智慧代理

不需要自訂標頭：將 agent id 編碼在 OpenAI 的 `model` 欄位中：

- `model: "openclaw:<agentId>"` (範例：`"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (別名)

或是透過標頭指定特定的 OpenClaw 智慧代理：

- `x-openclaw-agent-id: <agentId>` (預設值：`main`)

進階：

- `x-openclaw-session-key: <sessionKey>` 用於完全控制工作階段路由。

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

預設情況下，此端點對於每個請求是**無狀態的**（每次呼叫都會產生一個新的工作階段金鑰）。

如果請求中包含 OpenAI 的 `user` 字串，Gateway 會從中衍生出一個穩定的工作階段金鑰，因此重複呼叫可以共用智慧代理的工作階段。

## 串流 (SSE)

設定 `stream: true` 來接收伺服器傳送事件 (SSE)：

- `Content-Type: text/event-stream`
- 每一行事件為 `data: <json>`
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
