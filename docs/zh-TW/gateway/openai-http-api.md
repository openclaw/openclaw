---
summary: >-
  Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the
  Gateway
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: OpenAI Chat Completions
---

# OpenAI 聊天完成 (HTTP)

OpenClaw 的 Gateway 可以提供一個小型的 OpenAI 相容的聊天完成端點。

此端點預設為**禁用**。請先在設定中啟用它。

- `POST /v1/chat/completions`
- 與閘道相同的埠 (WS + HTTP 多路復用): `http://<gateway-host>:<port>/v1/chat/completions`

在底層，請求的執行方式與正常的 Gateway 代理執行相同（與 `openclaw agent` 相同的程式碼路徑），因此路由/權限/設定與您的 Gateway 相符。

## 認證

使用 Gateway 認證設定。發送 bearer token：

`Authorization: Bearer <token>`

[[BLOCK_1]]

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password` (或 `OPENCLAW_GATEWAY_PASSWORD`)。
- 如果 `gateway.auth.rateLimit` 已設定且發生過多的身份驗證失敗，端點將返回 `429` 以及 `Retry-After`。

## Security boundary (important)

將此端點視為網關實例的 **完整操作員訪問** 界面。

- 此處的 HTTP bearer 認證並不是一個狹隘的每位使用者範圍模型。
- 對於此端點，有效的 Gateway token/密碼應被視為擁有者/操作員的憑證。
- 請求通過與受信任操作員行動相同的控制平面代理路徑執行。
- 此端點沒有單獨的非擁有者/每位使用者的工具邊界；一旦呼叫者在此通過 Gateway 認證，OpenClaw 將該呼叫者視為此 Gateway 的受信任操作員。
- 如果目標代理政策允許使用敏感工具，則此端點可以使用它們。
- 僅將此端點保持在回環/尾網/私有入口；請勿直接將其暴露於公共互聯網。

請參閱 [Security](/gateway/security) 和 [Remote access](/gateway/remote)。

## Choosing an agent

不需要自訂標頭：將代理 ID 編碼在 OpenAI `model` 欄位中：

- `model: "openclaw:<agentId>"` (範例: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (別名)

或透過標頭針對特定的 OpenClaw 代理進行目標設定：

- `x-openclaw-agent-id: <agentId>` (預設值: `main`)

[[BLOCK_1]]

- `x-openclaw-session-key: <sessionKey>` 以完全控制會話路由。

## 啟用端點

Set `gateway.http.endpoints.chatCompletions.enabled` to `true`:

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

Set `gateway.http.endpoints.chatCompletions.enabled` to `false`:

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

預設情況下，端點是 **每個請求無狀態**（每次呼叫都會生成一個新的會話金鑰）。

如果請求包含 OpenAI `user` 字串，則 Gateway 會從中衍生出一個穩定的會話金鑰，以便重複的呼叫可以共享一個代理會話。

## Streaming (SSE)

將 `stream: true` 設定為接收伺服器傳送事件 (SSE)：

- `Content-Type: text/event-stream`
- 每個事件行是 `data: <json>`
- 串流以 `data: [DONE]` 結束

## Examples

[[BLOCK_1]]

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

[[BLOCK_1]]

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
