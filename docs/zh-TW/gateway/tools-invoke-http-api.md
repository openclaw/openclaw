---
summary: "透過 Gateway HTTP 端點直接呼叫單一工具"
read_when:
  - 無需執行完整的智慧代理回合即可呼叫工具
  - 建構需要工具策略強制執行的自動化
title: "工具呼叫 API"
---

# 工具呼叫 (HTTP)

OpenClaw 的 Gateway暴露一個簡單的 HTTP 端點，用於直接呼叫單一工具。它始終啟用，但受 Gateway認證和工具策略限制。

- `POST /tools/invoke`
- 與 Gateway相同的埠號 (WS + HTTP 多工)：`http://<gateway-host>:<port>/tools/invoke`

預設最大酬載大小為 2 MB。

## 認證

使用 Gateway認證設定。發送持有者權杖：

- `Authorization: Bearer <token>`

備註：

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password` (或 `OPENCLAW_GATEWAY_PASSWORD`)。
- 如果 `gateway.auth.rateLimit` 已設定且發生過多認證失敗，端點會傳回 `429` 和 `Retry-After`。

## 請求主體

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

欄位：

- `tool` (字串, 必需): 要呼叫的工具名稱。
- `action` (字串, 選用): 如果工具綱要支援 `action` 且 args 酬載省略它，則會映射到 args。
- `args` (物件, 選用): 工具專屬引數。
- `sessionKey` (字串, 選用): 目標工作階段鍵。如果省略或為 `"main"`，Gateway會使用已設定的主工作階段鍵 (遵循 `session.mainKey` 和預設智慧代理，或在全域範圍中使用 `global`)。
- `dryRun` (布林值, 選用): 保留供未來使用；目前忽略。

## 策略 + 路由行為

工具可用性會透過 Gateway智慧代理使用的相同策略鏈進行篩選：

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 群組策略 (如果工作階段鍵映射到群組或頻道)
- 子智慧代理策略 (當使用子智慧代理工作階段鍵呼叫時)

如果工具不被策略允許，端點會傳回 **404**。

Gateway HTTP 預設也會應用嚴格拒絕列表 (即使工作階段策略允許該工具)：

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

您可以透過 `gateway.tools` 自訂此拒絕列表：

```json5
{
  gateway: {
    tools: {
      // 透過 HTTP /tools/invoke 額外阻擋的工具
      deny: ["browser"],
      // 從預設拒絕列表中移除工具
      allow: ["gateway"],
    },
  },
}
```

為了協助群組策略解析上下文，您可以選擇設定：

- `x-openclaw-message-channel: <channel>` (範例: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (當存在多個帳戶時)

## 回應

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (無效請求或工具輸入錯誤)
- `401` → 未經授權
- `429` → 認證速率受限 (`Retry-After` 已設定)
- `404` → 工具不可用 (未找到或未列入允許列表)
- `405` → 方法不允許
- `500` → `{ ok: false, error: { type, message } }` (非預期的工具執行錯誤；已淨化訊息)

## 範例

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
