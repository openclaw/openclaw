---
summary: "用於喚醒與隔離代理程式執行的 Webhook 入口"
read_when:
  - 新增或變更 Webhook 端點時
  - 將外部系統接線至 OpenClaw
title: "Webhooks"
---

# Webhooks

Gateway 閘道器可以對外暴露一個小型的 HTTP Webhook 端點，供外部觸發使用。

## 啟用

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

注意事項：

- 當 `hooks.enabled=true` 時，需要 `hooks.token`。
- `hooks.path` 預設為 `/hooks`。

## Auth

Every request must include the hook token. Prefer headers:

- `Authorization: Bearer <token>`（建議）
- `x-openclaw-token: <token>`
- `?token=<token>`（已棄用；會記錄警告，並將於未來主要版本移除）

## 端點

### `POST /hooks/wake`

Payload：

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必填**（string）：事件的描述（例如：「New email received」）。
- `mode` 選填（`now` | `next-heartbeat`）：是否立即觸發心跳（預設 `now`），或等待下一次定期檢查。

效果：

- Enqueues a system event for the **main** session
- 若為 `mode=now`，則立即觸發心跳

### `POST /hooks/agent`

Payload：

```json
{
  "message": "Run this",
  "name": "Email",
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

- `message` **必填**（string）：要讓代理程式處理的提示或訊息。
- `name` 選填（string）：Hook 的人類可讀名稱（例如：「GitHub」），用作工作階段摘要中的前綴。
- `sessionKey` optional (string): The key used to identify the agent's session. Defaults to a random `hook:<uuid>`. Using a consistent key allows for a multi-turn conversation within the hook context.
- `wakeMode` 選填（`now` | `next-heartbeat`）：是否立即觸發心跳（預設 `now`），或等待下一次定期檢查。
- `deliver` 選填（boolean）：若為 `true`，代理程式的回應將送至訊息頻道。預設為 `true`。僅為心跳確認的回應會自動略過。 Defaults to `true`. Responses that are only heartbeat acknowledgments are automatically skipped.
- `channel` optional (string): The messaging channel for delivery. `channel` 選填（string）：投遞用的訊息頻道。其一：`last`、`whatsapp`、`telegram`、`discord`、`slack`、`mattermost`（外掛）、`signal`、`imessage`、`msteams`。預設為 `last`。 Defaults to `last`.
- `to` 選填（string）：該頻道的收件者識別碼（例如：WhatsApp/Signal 的電話號碼、Telegram 的 chat ID、Discord/Slack/Mattermost（外掛）的 channel ID、MS Teams 的 conversation ID）。預設為主要工作階段中的最後一位收件者。 Defaults to the last recipient in the main session.
- `model` 選填（string）：模型覆寫（例如：`anthropic/claude-3-5-sonnet` 或別名）。若有限制，必須包含於允許的模型清單中。 Must be in the allowed model list if restricted.
- `thinking` 選填（string）：思考層級覆寫（例如：`low`、`medium`、`high`）。
- `timeoutSeconds` 選填（number）：代理程式執行的最長時間（秒）。

效果：

- 執行一次 **隔離** 的代理程式回合（獨立的工作階段鍵）
- Always posts a summary into the **main** session
- 若為 `wakeMode=now`，則立即觸發心跳

### `POST /hooks/<name>`（映射）

Custom hook names are resolved via `hooks.mappings` (see configuration). A mapping can
turn arbitrary payloads into `wake` or `agent` actions, with optional templates or
code transforms.

映射選項（摘要）：

- `hooks.presets: ["gmail"]` 啟用內建的 Gmail 映射。
- `hooks.mappings` 可讓你在設定中定義 `match`、`action` 與範本。
- `hooks.transformsDir` + `transform.module` 載入 JS/TS 模組以實作自訂邏輯。
- 使用 `match.source` 以保留通用的 ingest 端點（以 Payload 驅動路由）。
- TS 轉換在執行時需要 TS 載入器（例如：`bun` 或 `tsx`），或預先編譯的 `.js`。
- 在映射上設定 `deliver: true` + `channel`/`to`，即可將回覆路由到聊天介面
  （`channel` 預設為 `last`，並回退至 WhatsApp）。
- `allowUnsafeExternalContent: true` 會停用該 Hook 的外部內容安全包裝
  （危險；僅適用於受信任的內部來源）。
- `openclaw webhooks gmail setup` 會為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。
  完整的 Gmail watch 流程請參見 [Gmail Pub/Sub](/automation/gmail-pubsub)。
  See [Gmail Pub/Sub](/automation/gmail-pubsub) for the full Gmail watch flow.

## 回應

- `200` 用於 `/hooks/wake`
- `202` 用於 `/hooks/agent`（已開始非同步執行）
- 驗證失敗時為 `401`
- Payload 無效時為 `400`
- Payload 過大時為 `413`

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

在代理程式 Payload（或映射）中加入 `model`，即可覆寫該次執行的模型：

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

若你強制 `agents.defaults.models`，請確保覆寫的模型包含於其中。

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 安全性

- 將 Hook 端點置於 loopback、tailnet，或受信任的反向代理之後。
- Use a dedicated hook token; do not reuse gateway auth tokens.
- 避免在 Webhook 記錄中包含敏感的原始 Payload。
- Hook payloads are treated as untrusted and wrapped with safety boundaries by default.
  If you must disable this for a specific hook, set `allowUnsafeExternalContent: true`
  in that hook's mapping (dangerous).
