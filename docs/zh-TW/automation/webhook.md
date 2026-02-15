---
summary: "用於喚醒和獨立智慧代理執行的 Webhook 輸入"
read_when:
  - 新增或變更 webhook 端點
  - 將外部系統連接到 OpenClaw
title: "Webhook"
---

# Webhook

Gateway 可以公開一個小型 HTTP webhook 端點，用於外部觸發。

## 啟用

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // Optional: restrict explicit `agentId` routing to this allowlist.
    // Omit or include "*" to allow any agent.
    // Set [] to deny all explicit `agentId` routing.
    allowedAgentIds: ["hooks", "main"],
  },
}
```

注意事項：

- `hooks.token` 為必填項，當 `hooks.enabled=true` 時。
- `hooks.path` 預設為 `/hooks`。

## 憑證

每個請求都必須包含 hook 權杖。建議使用標頭：

- `Authorization: Bearer <token>` (建議)
- `x-openclaw-token: <token>`
- 查詢字串權杖將被拒絕（`?token=...` 會回傳 `400`）。

## 端點

### `POST /hooks/wake`

酬載：

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必填** (字串)：事件的描述（例如：「收到新電子郵件」）。
- `mode` 選填 (`now` | `next-heartbeat`)：是否立即觸發心跳（預設 `now`）或等待下一次週期性檢查。

效果：

- 為 **主要** 工作階段排入一個系統事件
- 如果 `mode=now`，則觸發立即心跳

### `POST /hooks/agent`

酬載：

```json
{
  "message": "Run this",
  "name": "Email",
  "agentId": "hooks",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **必填** (字串)：智慧代理要處理的提示或訊息。
- `name` 選填 (字串)：hook 的人類可讀名稱（例如：「GitHub」），用作工作階段摘要中的前綴。
- `agentId` 選填 (字串)：將此 hook 路由到特定的智慧代理。未知 ID 會回退到預設智慧代理。設定後，hook 會使用解析後的智慧代理的工作區和設定執行。
- `sessionKey` 選填 (字串)：用於識別智慧代理工作階段的鍵。預設情況下，此欄位會被拒絕，除非 `hooks.allowRequestSessionKey=true`。
- `wakeMode` 選填 (`now` | `next-heartbeat`)：是否立即觸發心跳（預設 `now`）或等待下一次週期性檢查。
- `deliver` 選填 (布林值)：如果為 `true`，智慧代理的回應將傳送到訊息頻道。預設為 `true`。僅為心跳確認的回應會自動跳過。
- `channel` 選填 (字串)：用於傳送的訊息頻道。選項包括：`last`、`whatsapp`、`telegram`、`discord`、`slack`、`mattermost` (外掛)、`signal`、`imessage`、`msteams`。預設為 `last`。
- `to` 選填 (字串)：頻道的接收者識別碼（例如，WhatsApp/Signal 的電話號碼、Telegram 的聊天 ID、Discord/Slack/Mattermost (外掛) 的頻道 ID、MS Teams 的對話 ID）。預設為主要工作階段中的最後一個接收者。
- `model` 選填 (字串)：模型覆寫（例如，`anthropic/claude-3-5-sonnet` 或別名）。如果受限制，則必須在允許的模型列表中。
- `thinking` 選填 (字串)：思考等級覆寫（例如，`low`、`medium`、`high`）。
- `timeoutSeconds` 選填 (數字)：智慧代理執行時間的最大持續時間（秒）。

效果：

- 執行一個 **獨立** 的智慧代理回合（擁有自己的工作階段鍵）
- 總是將摘要發佈到 **主要** 工作階段
- 如果 `wakeMode=now`，則觸發立即心跳

## 工作階段鍵政策（重大變更）

`/hooks/agent` 酬載的 `sessionKey` 覆寫預設為停用。

- 建議：設定固定的 `hooks.defaultSessionKey` 並關閉請求覆寫。
- 選填：僅在需要時才允許請求覆寫，並限制前綴。

建議設定：

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

相容性設定（舊版行為）：

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"], // strongly recommended
  },
}
```

### `POST /hooks/<name>` (mapped)

自訂 hook 名稱透過 `hooks.mappings` 解析（請參閱設定）。映射可以將任意酬載轉換為喚醒或智慧代理動作，並帶有選填的模板或程式碼轉換。

映射選項（摘要）：

- `hooks.presets: ["gmail"]` 啟用內建的 Gmail 映射。
- `hooks.mappings` 讓您在設定中定義 `match`、`action` 和模板。
- `hooks.transformsDir` + `transform.module` 載入用於自訂邏輯的 JS/TS 模組。
- 使用 `match.source` 來保留通用攝取端點（酬載驅動的路由）。
- TS 轉換需要 TS 載入器（例如 `bun` 或 `tsx`）或執行時預編譯的 `.js`。
- 在映射上設定 `deliver: true` + `channel`/`to` 以將回覆路由到聊天介面（`channel` 預設為 `last` 並回退到 WhatsApp）。
- `agentId` 將 hook 路由到特定的智慧代理；未知 ID 會回退到預設智慧代理。
- `hooks.allowedAgentIds` 限制明確的 `agentId` 路由。省略它（或包含 `*`）以允許任何智慧代理。設定 `[]` 以拒絕明確的 `agentId` 路由。
- `hooks.defaultSessionKey` 會設定 hook 智慧代理執行的預設工作階段，當未提供明確的鍵時。
- `hooks.allowRequestSessionKey` 控制 `/hooks/agent` 酬載是否可以設定 `sessionKey`（預設：`false`）。
- `hooks.allowedSessionKeyPrefixes` 選填地限制來自請求酬載和映射的明確 `sessionKey` 值。
- `allowUnsafeExternalContent: true` 會停用該 hook 的外部內容安全包裝器（危險；僅適用於受信任的內部來源）。
- `openclaw webhooks gmail setup` 會為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。請參閱 [Gmail Pub/Sub](/automation/gmail-pubsub) 了解完整的 Gmail 監控流程。

## 回應

- `/hooks/wake` 回傳 `200`
- `/hooks/agent` 回傳 `202` (非同步執行已啟動)
- 憑證失敗時回傳 `401`
- 同一用戶端重複憑證失敗後回傳 `429`（請檢查 `Retry-After`）
- 無效酬載時回傳 `400`
- 酬載過大時回傳 `413`

## 範例

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### 使用不同的模型

將 `model` 新增到智慧代理酬載（或映射）中，以覆寫該次執行的模型：

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

如果您強制執行 `agents.defaults.models`，請確保覆寫模型包含在其中。

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 安全性

- 將 hook 端點保持在 local loopback、tailnet 或受信任的反向代理之後。
- 使用專用的 hook 權杖；請勿重複使用 Gateway 憑證權杖。
- 每個用戶端位址重複的憑證失敗會受到速率限制，以減緩暴力破解嘗試。
- 如果您使用多智慧代理路由，請設定 `hooks.allowedAgentIds` 以限制明確的 `agentId` 選取。
- 保持 `hooks.allowRequestSessionKey=false`，除非您需要呼叫者選擇的工作階段。
- 如果您啟用請求 `sessionKey`，請限制 `hooks.allowedSessionKeyPrefixes`（例如 `["hook:"]`）。
- 避免在 webhook 紀錄檔中包含敏感的原始酬載。
- Hook 酬載預設被視為不受信任，並用安全邊界包裝。如果您必須為特定 hook 停用此功能，請在該 hook 的映射中設定 `allowUnsafeExternalContent: true`（危險）。
