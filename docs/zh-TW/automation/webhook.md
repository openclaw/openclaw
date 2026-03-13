---
summary: Webhook ingress for wake and isolated agent runs
read_when:
  - Adding or changing webhook endpoints
  - Wiring external systems into OpenClaw
title: Webhooks
---

# Webhooks

Gateway 可以為外部觸發器暴露一個小型的 HTTP webhook 端點。

## Enable

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

[[BLOCK_1]]

- `hooks.token` 是在 `hooks.enabled=true` 時所必需的。
- `hooks.path` 預設為 `/hooks`。

## Auth

每個請求必須包含 hook token。建議使用標頭：

- `Authorization: Bearer <token>` (建議使用)
- `x-openclaw-token: <token>`
- 查詢字串中的 token 會被拒絕 (`?token=...` 會返回 `400`).

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必填** (字串)：事件的描述（例如："收到新郵件"）。
- `mode` 可選 (`now` | `next-heartbeat`): 是否立即觸發心跳（預設 `now`）或等待下一次定期檢查。

[[BLOCK_1]]

- 將系統事件排入 **主** 會話
- 如果 `mode=now`，則觸發即時心跳

### `POST /hooks/agent`

Payload:

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

- `message` **必填** (字串)：代理人處理的提示或訊息。
- `name` 選填 (字串)：用於會話摘要的可讀名稱（例如，“GitHub”），作為前綴。
- `agentId` 選填 (字串)：將此鉤子路由到特定的代理人。未知的 ID 將回退到預設代理人。設定後，鉤子將使用解析的代理人工作區和設定執行。
- `sessionKey` 選填 (字串)：用於識別代理人會話的鍵。預設情況下，除非 `hooks.allowRequestSessionKey=true`，否則此欄位會被拒絕。
- `wakeMode` 選填 (`now` | `next-heartbeat`): 是否立即觸發心跳（預設 `now`）或等待下一次定期檢查。
- `deliver` 選填 (布林值)：如果 `true`，代理人的回應將發送到消息通道。預設為 `true`。僅為心跳確認的回應會自動跳過。
- `channel` 選填 (字串)：交付的消息通道。可選之一：`last`、`whatsapp`、`telegram`、`discord`、`slack`、`mattermost` (插件)、`signal`、`imessage`、`msteams`。預設為 `last`。
- `to` 選填 (字串)：通道的接收者識別碼（例如，WhatsApp/Signal 的電話號碼，Telegram 的聊天 ID，Discord/Slack/Mattermost (插件) 的頻道 ID，MS Teams 的對話 ID）。預設為主會話中的最後一位接收者。
- `model` 選填 (字串)：模型覆蓋（例如，`anthropic/claude-3-5-sonnet` 或別名）。如果有限制，必須在允許的模型列表中。
- `thinking` 選填 (字串)：思考層級覆蓋（例如，`low`、`medium`、`high`）。
- `timeoutSeconds` 選填 (數字)：代理人執行的最大持續時間（以秒為單位）。

[[BLOCK_1]]

- 執行一個 **獨立** 的代理回合（擁有自己的會話金鑰）
- 總是將摘要發佈到 **主要** 會話中
- 如果 `wakeMode=now`，則觸發即時心跳

## Session key policy (breaking change)

`/hooks/agent` 負載 `sessionKey` 覆蓋預設是禁用的。

- 建議：設置固定的 `hooks.defaultSessionKey` 並關閉請求覆蓋。
- 可選：僅在需要時允許請求覆蓋，並限制前綴。

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
    allowedSessionKeyPrefixes: ["hook:"], // strongly recommended
  },
}
```

### `POST /hooks/<name>` (mapped)

自訂 hook 名稱透過 `hooks.mappings` 進行解析（請參見設定）。映射可以將任意有效載荷轉換為 `wake` 或 `agent` 動作，並可選擇使用模板或程式碼轉換。

[[BLOCK_1]]  
映射選項（摘要）：  
[[BLOCK_1]]

- `hooks.presets: ["gmail"]` 啟用內建的 Gmail 映射。
- `hooks.mappings` 讓你在設定中定義 `match`、`action` 和模板。
- `hooks.transformsDir` + `transform.module` 載入一個 JS/TS 模組以實現自訂邏輯。
  - `hooks.transformsDir`（如果設置）必須位於你的 OpenClaw 設定目錄下的轉換根目錄中（通常是 `~/.openclaw/hooks/transforms`）。
  - `transform.module` 必須在有效的轉換目錄中解析（遍歷/逃逸路徑會被拒絕）。
- 使用 `match.source` 來保持一個通用的接收端點（基於有效載荷的路由）。
- TS 轉換需要一個 TS 載入器（例如 `bun` 或 `tsx`）或在執行時預編譯的 `.js`。
- 在映射上設置 `deliver: true` + `channel`/`to` 以將回覆路由到聊天介面
  （`channel` 預設為 `last`，並回退到 WhatsApp）。
- `agentId` 將鉤子路由到特定代理；未知的 ID 會回退到預設代理。
- `hooks.allowedAgentIds` 限制明確的 `agentId` 路由。省略它（或包含 `*`）以允許任何代理。設置 `[]` 以拒絕明確的 `agentId` 路由。
- `hooks.defaultSessionKey` 設置在未提供明確鍵時鉤子代理執行的預設會話。
- `hooks.allowRequestSessionKey` 控制是否 `/hooks/agent` 有效載荷可以設置 `sessionKey`（預設：`false`）。
- `hooks.allowedSessionKeyPrefixes` 可選地限制請求有效載荷和映射中的明確 `sessionKey` 值。
- `allowUnsafeExternalContent: true` 禁用該鉤子的外部內容安全包裝器
  （危險；僅限於受信任的內部來源）。
- `openclaw webhooks gmail setup` 為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。
  請參閱 [Gmail Pub/Sub](/automation/gmail-pubsub) 以獲取完整的 Gmail 監控流程。

## Responses

- `200` 用於 `/hooks/wake`
- `200` 用於 `/hooks/agent` （接受非同步執行）
- `401` 在認證失敗時
- `429` 在同一用戶端重複認證失敗後 （檢查 `Retry-After`）
- `400` 在無效的有效載荷時
- `413` 在超大有效載荷時

## Examples

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

將 `model` 添加到代理有效載荷（或映射）中，以覆蓋該次執行的模型：

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

如果你強制執行 `agents.defaults.models`，請確保覆蓋模型包含在其中。

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- 將 hook 端點放在 loopback、tailnet 或受信任的反向代理後面。
- 使用專用的 hook token；不要重複使用網關認證 token。
- 重複的認證失敗會根據用戶端地址進行速率限制，以減緩暴力破解嘗試。
- 如果您使用多代理路由，請設置 `hooks.allowedAgentIds` 以限制明確的 `agentId` 選擇。
- 保留 `hooks.allowRequestSessionKey=false`，除非您需要呼叫者選擇的會話。
- 如果您啟用請求 `sessionKey`，請限制 `hooks.allowedSessionKeyPrefixes`（例如，`["hook:"]`）。
- 避免在 webhook 日誌中包含敏感的原始有效負載。
- hook 有效負載預設被視為不受信任，並包裹在安全邊界內。
  如果您必須為特定的 hook 禁用此功能，請在該 hook 的映射中設置 `allowUnsafeExternalContent: true`（危險）。
