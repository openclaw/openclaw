---
summary: 「從 Gateway 公開一個與 OpenAI 相容的 /v1/chat/completions HTTP 端點」
read_when:
  - 「整合需要 OpenAI Chat Completions 的工具」
title: 「OpenAI Chat Completions」
x-i18n:
  source_path: gateway/openai-http-api.md
  source_hash: 6f935777f489bff9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:04Z
---

# OpenAI Chat Completions（HTTP）

OpenClaw 的 Gateway 可以提供一個小型、與 OpenAI 相容的 Chat Completions 端點。

此端點**預設為停用**。請先在設定中啟用。

- `POST /v1/chat/completions`
- 與 Gateway 使用相同的連接埠（WS + HTTP 多工）：`http://<gateway-host>:<port>/v1/chat/completions`

在內部實作上，請求會以一般的 Gateway 代理程式執行流程來處理（與 `openclaw agent` 相同的程式碼路徑），因此路由、權限與設定都會符合你的 Gateway。

## 身分驗證

使用 Gateway 的身分驗證設定。請傳送 Bearer 權杖：

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

## 啟用端點

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

## 工作階段行為

預設情況下，該端點**每個請求皆為無狀態**（每次呼叫都會產生新的工作階段金鑰）。

如果請求包含 OpenAI 的 `user` 字串，Gateway 會從中衍生出穩定的工作階段金鑰，讓重複呼叫能夠共用同一個代理程式工作階段。

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
