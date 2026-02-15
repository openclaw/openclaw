---
summary: "用於喚醒與獨立智慧代理執行的 Webhook 入口"
read_when:
  - 新增或變更 webhook 端點時
  - 將外部系統接入 OpenClaw 時
  title: "Webhooks"
---

# Webhooks

Gateway 可以提供一個輕量級的 HTTP webhook 端點來接收外部觸發。

## 啟用

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // 選填：將明確的 `agentId` 路由限制在此允許清單中。
    // 省略或包含 "*" 以允許任何智慧代理。
    // 設定為 [] 以拒絕所有明確的 `agentId` 路由。
    allowedAgentIds: ["hooks", "main"],
  },
}
```

備註：

- 當 `hooks.enabled=true` 時，必須設定 `hooks.token`。
- `hooks.path` 預設為 `/hooks`。

## 驗證

每個請求都必須包含 hook token。建議使用標頭（headers）：

- `Authorization: Bearer <token>`（推薦）
- `x-openclaw-token: <token>`
- 拒絕在查詢字串（Query-string）中使用 token（例如 `?token=...` 將回傳 `400`）。

## 端點

### `POST /hooks/wake`

內容（Payload）：

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必填** (string)：事件的描述（例如：「收到新郵件」）。
- `mode` 選填 (`now` | `next-heartbeat`)：是否立即觸發 heartbeat（預設為 `now`），或等待下一次定期檢查。

效果：

- 為 **main** 工作階段將系統事件加入佇列
- 如果 `mode=now`，會立即觸發 heartbeat

### `POST /hooks/agent`

內容（Payload）：

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

- `message` **必填** (string)：交由智慧代理處理的提示詞（prompt）或訊息。
- `name` 選填 (string)：hook 的易讀名稱（例如：「GitHub」），用於工作階段摘要的前置詞。
- `agentId` 選填 (string)：將此 hook 路由到特定的智慧代理。未知的 ID 將回退（fallback）至預設智慧代理。設定後，該 hook 將使用解析後的智慧代理工作區與設定執行。
- `sessionKey` 選填 (string)：用於識別智慧代理工作階段的鍵值。除非 `hooks.allowRequestSessionKey=true`，否則預設會拒絕此欄位。
- `wakeMode` 選填 (`now` | `next-heartbeat`)：是否立即觸發 heartbeat（預設為 `now`），或等待下一次定期檢查。
- `deliver` 選填 (boolean)：如果為 `true`，智慧代理的回應將會發送到通訊頻道。預設為 `true`。僅作為 heartbeat 確認的回應會自動跳過。
- `channel` 選填 (string)：傳送訊息的通訊頻道。可選：`last`、`whatsapp`、`telegram`、`discord`、`slack`、`mattermost` (plugin)、`signal`、`imessage`、`msteams`。預設為 `last`。
- `to` 選填 (string)：頻道的接收者識別碼（例如：WhatsApp/Signal 的電話號碼、Telegram 的聊天 ID、Discord/Slack/Mattermost (plugin) 的頻道 ID、MS Teams 的對話 ID）。預設為 main 工作階段中的最後一位接收者。
- `model` 選填 (string)：覆蓋模型設定（例如：`anthropic/claude-3-5-sonnet` 或別名）。如果受限，則必須在允許的模型清單中。
- `thinking` 選填 (string)：覆蓋思考層級（例如：`low`、`medium`、`high`）。
- `timeoutSeconds` 選填 (number)：智慧代理執行的最大秒數。

效果：

- 執行**獨立**的智慧代理輪次（擁有自己的 session key）
- 一律將摘要發布到 **main** 工作階段
- 如果 `wakeMode=now`，會立即觸發 heartbeat

## 工作階段鍵值政策（破壞性變更）

`/hooks/agent` payload 的 `sessionKey` 覆蓋功能預設為停用。

- 推薦：設定固定的 `hooks.defaultSessionKey` 並保持請求覆蓋功能關閉。
- 選用：僅在需要時允許請求覆蓋，並限制前綴。

推薦設定：

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
    allowedSessionKeyPrefixes: ["hook:"], // 強烈推薦
  },
}
```

### `POST /hooks/<name>` (映射)

自訂 hook 名稱透過 `hooks.mappings` 進行解析（參見設定）。映射可以將任意內容（payload）轉換為 `wake` 或 `agent` 動作，並可選用範本或程式碼轉換（transforms）。

映射選項（摘要）：

- `hooks.presets: ["gmail"]` 啟用內建的 Gmail 映射。
- `hooks.mappings` 讓您在設定中定義 `match`、`action` 與範本。
- `hooks.transformsDir` + `transform.module` 載入 JS/TS 模組以執行自訂邏輯。
- 使用 `match.source` 來維持通用的接收端點（由內容驅動路由）。
- TS 轉換在執行時需要 TS 載入器（例如 `bun` 或 `tsx`）或預編譯的 `.js`。
- 在映射上設定 `deliver: true` + `channel`/`to`，將回覆路由到聊天介面（`channel` 預設為 `last`，並可回退到 WhatsApp）。
- `agentId` 將 hook 路由到特定的智慧代理；未知的 ID 將回退至預設智慧代理。
- `hooks.allowedAgentIds` 限制明確的 `agentId` 路由。省略它（或包含 `*`）以允許任何智慧代理。設定為 `[]` 則拒絕明確的 `agentId` 路由。
- `hooks.defaultSessionKey` 在未提供明確鍵值時，為 hook 智慧代理執行設定預設工作階段。
- `hooks.allowRequestSessionKey` 控制 `/hooks/agent` payload 是否可以設定 `sessionKey`（預設為 `false`）。
- `hooks.allowedSessionKeyPrefixes` 可選擇性地限制請求內容（payload）與映射中的明確 `sessionKey` 值。
- `allowUnsafeExternalContent: true` 停用該 hook 的外部內容安全封裝（危險；僅用於受信任的內部來源）。
- `openclaw webhooks gmail setup` 為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。請參見 [Gmail Pub/Sub](/automation/gmail-pubsub) 了解完整的 Gmail 監測流程。

## 回應

- `/hooks/wake` 回傳 `200`
- `/hooks/agent` 回傳 `202`（已開始非同步執行）
- 驗證失敗回傳 `401`
- 來自同一用戶端的重複驗證失敗回傳 `429`（請檢查 `Retry-After`）
- 無效內容（payload）回傳 `400`
- 內容（payload）過大回傳 `413`

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

在智慧代理內容（或映射）中加入 `model`，以覆蓋該次執行的模型設定：

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

如果您強制執行 `agents.defaults.models`，請確保覆蓋的模型包含在其中。

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 安全性

- 將 hook 端點置於 local loopback、tailnet 或受信任的反向代理（reverse proxy）之後。
- 使用專用的 hook token；不要重複使用 Gateway 驗證 token。
- 針對每個用戶端地址對重複的驗證失敗進行速率限制（rate-limited），以減緩暴力破解嘗試。
- 如果您使用多智慧代理路由，請設定 `hooks.allowedAgentIds` 以限制明確的 `agentId` 選擇。
- 除非您需要由呼叫者選擇工作階段，否則請保持 `hooks.allowRequestSessionKey=false`。
- 如果您啟用了請求 `sessionKey`，請限制 `hooks.allowedSessionKeyPrefixes`（例如：`["hook:"]`）。
- 避免在 webhook 紀錄中包含敏感的原始內容（payload）。
- Hook 內容（payload）預設被視為不可信，並由安全邊界封裝。如果您必須為特定 hook 停用此功能，請在該 hook 的映射中設定 `allowUnsafeExternalContent: true`（危險）。
