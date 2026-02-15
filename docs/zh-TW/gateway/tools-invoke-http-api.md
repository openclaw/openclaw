---
summary: "透過 Gateway HTTP 端點直接調用單個工具"
read_when:
  - 在不執行完整智慧代理輪次的情況下調用工具
  - 構建需要強制執行工具策略的自動化
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw 的 Gateway 提供了一個簡單的 HTTP 端點，用於直接調用單個工具。此端點始終處於啟用狀態，但受 Gateway 驗證和工具策略的限制。

- `POST /tools/invoke`
- 與 Gateway 相同的連接埠（WS + HTTP 多路復用）：`http://<gateway-host>:<port>/tools/invoke`

預設最大承載量（payload）大小為 2 MB。

## 驗證

使用 Gateway 驗證設定。請傳送 Bearer Token：

- `Authorization: Bearer <token>`

注意：

- 當 `gateway.auth.mode="token"` 時，使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 當 `gateway.auth.mode="password"` 時，使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。
- 如果配置了 `gateway.auth.rateLimit` 且發生太多次驗證失敗，該端點將回傳 `429` 並帶有 `Retry-After`。

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

- `tool` (string, 必填): 要調用的工具名稱。
- `action` (string, 選填): 如果工具架構（schema）支援 `action` 且 args 承載量中省略了該欄位，則會對應到 args。
- `args` (object, 選填): 工具特定參數。
- `sessionKey` (string, 選填): 目標工作階段金鑰。如果省略或為 `"main"`，Gateway 將使用設定的主工作階段金鑰（遵循 `session.mainKey` 和預設智慧代理，或全域範圍中的 `global`）。
- `dryRun` (boolean, 選填): 預留供未來使用；目前會被忽略。

## 策略與路由行為

工具的可用性會透過與 Gateway 智慧代理相同的策略鏈進行過濾：

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 群組策略（如果工作階段金鑰對應到群組或頻道）
- 子代理策略（當使用子代理工作階段金鑰調用時）

如果策略不允許使用該工具，端點將回傳 **404**。

預設情況下，Gateway HTTP 還會套用硬性拒絕清單（即使工作階段策略允許該工具）：

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

您可以透過 `gateway.tools` 自定義此拒絕清單：

```json5
{
  gateway: {
    tools: {
      // 額外要在 HTTP /tools/invoke 中封鎖的工具
      deny: ["browser"],
      // 從預設拒絕清單中移除工具
      allow: ["gateway"],
    },
  },
}
```

為了幫助群組策略解析上下文，您可以選擇性地設定：

- `x-openclaw-message-channel: <channel>` (例如: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (當存在多個帳號時)

## 回應

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (無效請求或工具輸入錯誤)
- `401` → 未經授權
- `429` → 驗證速率限制（已設定 `Retry-After`）
- `404` → 工具不可用（找不到或不在允許清單中）
- `405` → 方法不允許
- `500` → `{ ok: false, error: { type, message } }` (非預期的工具執行錯誤；已清理的訊息)

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
