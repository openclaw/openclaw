---
summary: "從 Gateway 公開一個與 OpenAI 相容的 /v1/chat/completions HTTP 端點"
read_when:
  - 整合需要 OpenAI Chat Completions 的工具
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions（HTTP）

OpenClaw 的 Gateway 可以提供一個小型、與 OpenAI 相容的 Chat Completions 端點。

此端點**預設為停用**。請先在設定中啟用。 請先在設定中啟用。

- `POST /v1/chat/completions`
- 與 Gateway 使用相同的連接埠（WS + HTTP 多工）：`http://<gateway-host>:<port>/v1/chat/completions`

在內部實作上，請求會以一般的 Gateway 代理程式執行流程來處理（與 `openclaw agent` 相同的程式碼路徑），因此路由、權限與設定都會符合你的 Gateway。

## Authentication

Uses the Gateway auth configuration. 傳送 Bearer 權杖：

- `Authorization: Bearer <token>`

注意事項：

- 當 `gateway.auth.mode="token"` 時，請使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 當 `gateway.auth.mode="password"` 時，請使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。

## 選擇代理程式

不需要自訂標頭：在 OpenAI 的 `model` 欄位中編碼代理程式 ID：

- `model: "openclaw:<agentId>"`（例如：`"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（別名）

或透過標頭指定特定的 OpenClaw 代理程式：

- `x-openclaw-agent-id: <agentId>`（預設：`main`）

進階：

- `x-openclaw-session-key: <sessionKey>` 以完整控制工作階段路由。

## Enabling the endpoint

將 `gateway.http.endpoints.chatCompletions.enabled` 設為 `true`：

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

將 `gateway.http.endpoints.chatCompletions.enabled` 設為 `false`：

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

## Session behavior

By default the endpoint is **stateless per request** (a new session key is generated each call).

If the request includes an OpenAI `user` string, the Gateway derives a stable session key from it, so repeated calls can share an agent session.

## 串流（SSE）

將 `stream: true` 設定為接收 Server-Sent Events（SSE）：

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
