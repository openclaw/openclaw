---
summary: Invoke a single tool directly via the Gateway HTTP endpoint
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: Tools Invoke API
---

# Tools Invoke (HTTP)

OpenClaw 的 Gateway 提供了一個簡單的 HTTP 端點，用於直接調用單一工具。它始終啟用，但受到 Gateway 認證和工具政策的限制。

- `POST /tools/invoke`
- 與閘道相同的埠 (WS + HTTP 多路復用): `http://<gateway-host>:<port>/tools/invoke`

預設的最大有效載荷大小為 2 MB。

## 認證

使用 Gateway 認證設定。發送 bearer token：

`Authorization: Bearer <token>`

[[BLOCK_1]]

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password` (或 `OPENCLAW_GATEWAY_PASSWORD`)。
- 如果 `gateway.auth.rateLimit` 已設定且發生過多的身份驗證失敗，端點將返回 `429` 以及 `Retry-After`。

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fields:

- `tool` (字串，必填)：要呼叫的工具名稱。
- `action` (字串，選填)：如果工具架構支援 `action` 且未提供 args 負載，則映射到 args。
- `args` (物件，選填)：特定於工具的參數。
- `sessionKey` (字串，選填)：目標會話金鑰。如果省略或 `"main"`，則 Gateway 使用設定的主要會話金鑰（遵循 `session.mainKey` 和預設代理，或 `global` 在全域範圍內）。
- `dryRun` (布林值，選填)：保留供未來使用；目前被忽略。

## 政策 + 路由行為

工具的可用性是通過與 Gateway 代理相同的政策鏈進行過濾的：

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 群組政策（如果會話金鑰對應到一個群組或頻道）
- 子代理政策（當使用子代理會話金鑰時）

如果工具不符合政策，端點將返回 **404**。

Gateway HTTP 預設也會應用一個硬性拒絕清單（即使會話政策允許該工具）：

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

您可以透過 `gateway.tools` 自訂此拒絕清單：

```json5
{
  gateway: {
    tools: {
      // Additional tools to block over HTTP /tools/invoke
      deny: ["browser"],
      // Remove tools from the default deny list
      allow: ["gateway"],
    },
  },
}
```

為了幫助群組政策解析上下文，您可以選擇性地設定：

- `x-openclaw-message-channel: <channel>` (範例: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (當存在多個帳戶時)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (無效的請求或工具輸入錯誤)
- `401` → 未授權
- `429` → 認證速率限制 (`Retry-After` 設定)
- `404` → 工具不可用 (未找到或未列入允許清單)
- `405` → 方法不允許
- `500` → `{ ok: false, error: { type, message } }` (意外的工具執行錯誤；已清理的訊息)

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
