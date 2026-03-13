---
summary: "閘道排程器的 Cron 工作 + 喚醒"
read_when:
  - 安排背景工作或喚醒時
  - 串接應與心跳（heartbeats）一同或同步執行的自動化時
  - 在心跳和 cron 之間決定排程任務時
title: "Cron 工作"
---

# Cron 工作 (閘道排程器)

> **Cron vs 心跳？** 請參閱 [Cron vs 心跳](/automation/cron-vs-heartbeat) 以取得何時使用各項功能的指引。

Cron 是閘道（Gateway）內建的排程器。它可以持久化儲存工作、在正確的時間喚醒代理（agent），並可選擇性地將輸出傳回聊天室。

如果您想要「每天早上執行此任務」或「在 20 分鐘後提醒代理」，cron 就是對應的機制。

故障排除：[/automation/troubleshooting](/automation/troubleshooting)

## 重點摘要

- Cron 執行於 **閘道內部**（而非模型內部）。
- 工作持久化儲存在 `~/.openclaw/cron/` 下，因此重新啟動不會遺失排程。
- 兩種執行風格：
  - **主會話 (Main session)**：將系統事件加入佇列，然後在下一次心跳時執行。
  - **隔離會話 (Isolated)**：在 `cron:<jobId>` 中執行專用的代理輪次，並進行傳遞（預設為宣告通知或無）。
- 喚醒是第一優先的：工作可以請求「立即喚醒」對比「下一次心跳」。
- Webhook 發送是針對每個工作透過 `delivery.mode = "webhook"` + `delivery.to = "<url>"` 進行。
- 針對設定了 `notify: true` 且已設定 `cron.webhook` 的儲存工作，仍保留舊有相容性，請將這些工作遷移至 webhook 傳遞模式。
- 對於升級，`openclaw doctor --fix` 可以在排程器處理之前規範舊有的 cron 儲存欄位。

## 快速開始（可操作）

建立一個單次提醒，驗證其存在，並立即執行：

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

安排一個具備傳遞功能的重複性隔離工作：

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## 工具呼叫等效項（閘道 cron 工具）

有關規範的 JSON 形式和範例，請參閱 [工具呼叫的 JSON 綱要](/automation/cron-jobs#json-schema-for-tool-calls)。

## Cron 工作儲存在哪裡

Cron 工作預設持久化儲存在閘道主機的 `~/.openclaw/cron/jobs.json`。
閘道會將檔案載入記憶體並在變更時寫回，因此只有在閘道停止時手動編輯才是安全的。建議優先使用 `openclaw cron add/edit` 或 cron 工具呼叫 API 進行變更。

## 入門級概述

將 cron 工作想像為：**何時** 執行 + **做什麼**。

1. **選擇排程**
   - 單次提醒 → `schedule.kind = "at"` (CLI: `--at`)
   - 重複工作 → `schedule.kind = "every"` 或 `schedule.kind = "cron"`
   - 如果您的 ISO 時間戳記省略了時區，它會被視為 **UTC**。

2. **選擇執行位置**
   - `sessionTarget: "main"` → 在下一次心跳期間使用主上下文執行。
   - `sessionTarget: "isolated"` → 在 `cron:<jobId>` 中執行專用的代理輪次。

3. **選擇有效載荷 (Payload)**
   - 主會話 → `payload.kind = "systemEvent"`
   - 隔離會話 → `payload.kind = "agentTurn"`

選用：單次工作（`schedule.kind = "at"`）預設在成功後刪除。設定 `deleteAfterRun: false` 以保留它們（它們會在成功後停用）。

## 概念

### 工作 (Jobs)

Cron 工作是一條儲存的紀錄，包含：

- **排程**（何時應執行），
- **有效載荷**（應做什麼），
- 選用的 **傳遞模式**（`announce`, `webhook`, 或 `none`）。
- 選用的 **代理綁定** (`agentId`)：在特定代理下執行工作；如果缺失或未知，閘道會退回到預設代理。

工作由穩定的 `jobId` 識別（由 CLI/閘道 API 使用）。
在代理工具呼叫中，`jobId` 是規範的；為了相容性，也接受舊有的 `id`。
單次工作預設在成功後自動刪除；設定 `deleteAfterRun: false` 以保留它們。

### 排程 (Schedules)

Cron 支援三種排程類型：

- `at`：透過 `schedule.at` 設定的單次時間戳記 (ISO 8601)。
- `every`：固定間隔 (ms)。
- `cron`：帶有選用 IANA 時區的 5 欄位 cron 表達式（或帶有秒數的 6 欄位）。

Cron 表達式使用 `croner`。如果省略時區，則使用閘道主機的本地時區。

為了減少多個閘道在整點時的負載峰值，OpenClaw 對於重複性的整點表達式（例如 `0 * * * *`, `0 */2 * * *`）會套用每個工作高達 5 分鐘的確定性交錯窗口（stagger window）。固定小時的表達式（如 `0 7 * * *`）則保持精確。

對於任何 cron 排程，您都可以透過 `schedule.staggerMs` 設定明確的交錯窗口（`0` 保持精確計時）。CLI 捷徑：

- `--stagger 30s`（或 `1m`, `5m`）來設定明確的交錯窗口。
- `--exact` 強制設定 `staggerMs = 0`。

### 主執行 vs 隔離執行

#### 主會話工作 (系統事件)

主工作會將系統事件加入佇列，並可選擇性地喚醒心跳執行器。
它們必須使用 `payload.kind = "systemEvent"`。

- `wakeMode: "now"` (預設)：事件立即觸發心跳執行。
- `wakeMode: "next-heartbeat"`：事件等待下一次排定的心跳。

當您需要正常的心跳提示詞 + 主會話上下文時，這是最佳選擇。
請參閱 [心跳](/gateway/heartbeat)。

#### 隔離工作 (專用 cron 會話)

隔離工作在會話 `cron:<jobId>` 中執行專用的代理輪次。

關鍵行為：

- 提示詞會加上前綴 `[cron:<jobId> <job name>]` 以便追蹤。
- 每次執行都會啟動一個 **全新的會話 ID**（不帶入之前的對話）。
- 預設行為：如果省略 `delivery`，隔離工作會宣告摘要 (`delivery.mode = "announce"`)。
- `delivery.mode` 選擇發生的情況：
  - `announce`：將摘要傳遞到目標頻道，並在主會話中發佈簡短摘要。
  - `webhook`：當完成事件包含摘要時，將完成事件的有效載荷 POST 到 `delivery.to`。
  - `none`：僅限內部（不傳遞，無主會話摘要）。
- `wakeMode` 控制主會話摘要發佈的時間：
  - `now`：立即心跳。
  - `next-heartbeat`：等待下一次排定的心跳。

對於不應干擾主聊天記錄的嘈雜、頻繁或「背景雜務」，請使用隔離工作。

### 有效載荷形式 (執行內容)

支援兩種有效載荷類型：

- `systemEvent`：僅限主會話，透過心跳提示詞路由。
- `agentTurn`：僅限隔離會話，執行專用的代理輪次。

常見的 `agentTurn` 欄位：

- `message`：必要的文字提示詞。
- `model` / `thinking`：選用的覆蓋設定（見下文）。
- `timeoutSeconds`：選用的逾時覆蓋。
- `lightContext`：針對不需要工作區引導檔案注入的工作，選用的輕量級引導模式。

傳遞設定：

- `delivery.mode`：`none` | `announce` | `webhook`。
- `delivery.channel`：`last` 或特定頻道。
- `delivery.to`：特定頻道的接收者 (announce) 或 Webhook URL (webhook 模式)。
- `delivery.bestEffort`：若宣告傳遞失敗，避免工作失敗。

宣告傳遞會抑制該次執行的訊息工具發送；請改用 `delivery.channel`/`delivery.to` 來鎖定聊天室。當 `delivery.mode = "none"` 時，主會話中不會發佈摘要。

如果隔離工作省略了 `delivery`，OpenClaw 預設為 `announce`。

#### 宣告傳遞流程 (Announce delivery flow)

當 `delivery.mode = "announce"` 時，cron 直接透過外傳頻道配接器進行傳遞。
主代理不會被啟動來撰寫或轉發訊息。

行為細節：

- 內容：傳遞使用隔離執行的外傳有效載荷（文字/媒體），並帶有正常的區塊化和頻道格式化。
- 僅限心跳的響應（沒有實際內容的 `HEARTBEAT_OK`）不會被傳遞。
- 如果隔離執行已經透過訊息工具向同一目標發送了訊息，則會跳過傳遞以避免重複。
- 缺失或無效的傳遞目標會導致工作失敗，除非 `delivery.bestEffort = true`。
- 只有當 `delivery.mode = "announce"` 時，才會在主會話中發佈短摘要。
- 主會話摘要遵循 `wakeMode`：`now` 觸發立即心跳，`next-heartbeat` 等待下一次排定的心跳。

#### Webhook 傳遞流程

當 `delivery.mode = "webhook"` 時，cron 在完成事件包含摘要時，將完成事件的有效載荷 POST 到 `delivery.to`。

行為細節：

- 端點必須是有效的 HTTP(S) URL。
- 在 webhook 模式下不嘗試頻道傳遞。
- 在 webhook 模式下不發佈主會話摘要。
- 如果設定了 `cron.webhookToken`，驗證標頭為 `Authorization: Bearer <cron.webhookToken>`。
- 棄用的退回方案：設定為 `notify: true` 的舊有儲存工作仍會發送到 `cron.webhook`（如果已設定），並帶有警告，以便您可以遷移至 `delivery.mode = "webhook"`。

### 模型與思考覆蓋

隔離工作 (`agentTurn`) 可以覆蓋模型和思考層級：

- `model`：提供者/模型字串（例如 `anthropic/claude-sonnet-4-20250514`）或別名（例如 `opus`）
- `thinking`：思考層級（`off`, `minimal`, `low`, `medium`, `high`, `xhigh`；僅限 GPT-5.2 + Codex 模型）

注意：您也可以在主會話工作上設定 `model`，但這會變更共享的主會話模型。我們建議僅對隔離工作使用模型覆蓋，以避免非預期的上下文切換。

解析優先順序：

1. 工作有效載荷覆蓋（最高）
2. 鉤子特定預設值（例如 `hooks.gmail.model`）
3. 代理配置預設值

### 輕量級引導上下文 (Lightweight bootstrap context)

隔離工作 (`agentTurn`) 可以設定 `lightContext: true` 以使用輕量級引導上下文執行。

- 對於不需要工作區引導檔案注入的排程雜務，請使用此設定。
- 在實踐中，內嵌執行階段會以 `bootstrapContextMode: "lightweight"` 執行，這會刻意保持 cron 引導上下文為空。
- CLI 等效項：`openclaw cron add --light-context ...` 和 `openclaw cron edit --light-context`。

### 傳遞 (頻道 + 目標)

隔離工作可以透過頂層的 `delivery` 配置將輸出傳遞到頻道：

- `delivery.mode`：`announce`（頻道傳遞）、`webhook`（HTTP POST）或 `none`。
- `delivery.channel`：`whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (插件) / `signal` / `imessage` / `last`。
- `delivery.to`：特定頻道的收件者目標。

`announce` 傳遞僅對隔離工作有效 (`sessionTarget: "isolated"`)。
`webhook` 傳遞對主會話和隔離工作皆有效。

如果省略 `delivery.channel` 或 `delivery.to`，cron 可以退回到主會話的「最後路由」（代理最後回覆的地方）。

目標格式提醒：

- Slack/Discord/Mattermost (插件) 目標應使用明確的前綴（例如 `channel:<id>`, `user:<id>`）以避免歧義。
  Mattermost 的 26 字元 ID 會優先解析為 **使用者**（若使用者存在則為 DM，否則為頻道）——請使用 `user:<id>` 或 `channel:<id>` 進行確定性路由。
- Telegram 討論串應使用 `:topic:` 形式（見下文）。

#### Telegram 傳遞目標 (討論串 / 論壇貼文串)

Telegram 透過 `message_thread_id` 支援論壇討論串。對於 cron 傳遞，您可以在 `to` 欄位中編碼討論串/貼文串：

- `-1001234567890` (僅限聊天 ID)
- `-1001234567890:topic:123` (偏好：明確的討論串標記)
- `-1001234567890:123` (簡寫：數字字尾)

也接受如 `telegram:...` / `telegram:group:...` 的前綴目標：

- `telegram:group:-1001234567890:topic:123`

## 工具呼叫的 JSON 綱要

當直接呼叫閘道 `cron.*` 工具（代理工具呼叫或 RPC）時，請使用這些形式。
CLI 標記接受如 `20m` 的人類友善時長，但工具呼叫應針對 `schedule.at` 使用 ISO 8601 字串，並針對 `schedule.everyMs` 使用毫秒。

### cron.add 參數

單次、主會話工作 (系統事件)：

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

重複、具備傳遞功能的隔離工作：

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates.",
    "lightContext": true
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

注意：

- `schedule.kind`：`at` (`at`), `every` (`everyMs`), 或 `cron` (`expr`, 選用 `tz`)。
- `schedule.at` 接受 ISO 8601（時區選用；省略時視為 UTC）。
- `everyMs` 為毫秒。
- `sessionTarget` 必須為 `"main"` 或 `"isolated"` 且必須與 `payload.kind` 匹配。
- 選用欄位：`agentId`, `description`, `enabled`, `deleteAfterRun`（對於 `at` 預設為 true），
  `delivery`。
- `wakeMode` 省略時預設為 `"now"`。

### cron.update 參數

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

注意：

- `jobId` 是規範的；為了相容性也接受 `id`。
- 在 patch 中使用 `agentId: null` 來清除代理綁定。

### cron.run 與 cron.remove 參數

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 儲存與歷史紀錄

- 工作儲存：`~/.openclaw/cron/jobs.json` (由閘道管理的 JSON)。
- 執行歷史：`~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL，根據大小和行數自動修剪)。
- 在 `sessions.json` 中的隔離 cron 執行會話會根據 `cron.sessionRetention` 進行修剪（預設 `24h`；設定為 `false` 則停用）。
- 覆蓋儲存路徑：配置中的 `cron.store`。

## 重試策略

當工作失敗時，OpenClaw 會將錯誤分類為 **暫時性**（可重試）或 **永久性**（立即停用）。

### 暫時性錯誤（會重試）

- 速率限制 (429, too many requests, resource exhausted)
- 提供者過載（例如 Anthropic `529 overloaded_error`，過載退回摘要）
- 網路錯誤（逾時, ECONNRESET, 擷取失敗, socket）
- 伺服器錯誤 (5xx)
- 與 Cloudflare 相關的錯誤

### 永久性錯誤（不重試）

- 驗證失敗（無效的 API key, 未授權）
- 配置或驗證錯誤
- 其他非暫時性錯誤

### 預設行為（無配置時）

**單次工作 (`schedule.kind: "at"`)：**

- 遇到暫時性錯誤：最多重試 3 次，並使用指數退避（30s → 1m → 5m）。
- 遇到永久性錯誤：立即停用。
- 成功或跳過：停用（或若 `deleteAfterRun: true` 則刪除）。

**重複性工作 (`cron` / `every`)：**

- 遇到任何錯誤：在下一次排定執行前套用指數退避 (30s → 1m → 5m → 15m → 60m)。
- 工作保持啟用狀態；退避會在下一次成功執行後重設。

配置 `cron.retry` 以覆蓋這些預設值（參見 [配置](/automation/cron-jobs#configuration)）。

## 配置

```json5
{
  cron: {
    enabled: true, // 預設為 true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // 預設為 1
    // 選用：針對單次工作覆蓋重試策略
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "server_error"],
    },
    webhook: "https://example.invalid/legacy", // 針對儲存的 notify:true 工作之棄用退回方案
    webhookToken: "replace-with-dedicated-webhook-token", // webhook 模式的選用 bearer token
    sessionRetention: "24h", // 時長字串或 false
    runLog: {
      maxBytes: "2mb", // 預設為 2,000,000 位元組
      keepLines: 2000, // 預設為 2000 行
    },
  },
}
```

執行日誌修剪行為：

- `cron.runLog.maxBytes`：修剪前執行日誌檔案的最大大小。
- `cron.runLog.keepLines`：修剪時，僅保留最新的 N 行。
- 兩者皆套用於 `cron/runs/<jobId>.jsonl` 檔案。

Webhook 行為：

- 建議：針對每個工作設定 `delivery.mode: "webhook"` 並搭配 `delivery.to: "https://..."`。
- Webhook URL 必須是有效的 `http://` 或 `https://` URL。
- 發送時，有效載荷為 cron 完成事件的 JSON。
- 如果設定了 `cron.webhookToken`，驗證標頭為 `Authorization: Bearer <cron.webhookToken>`。
- 如果未設定 `cron.webhookToken`，則不發送 `Authorization` 標頭。
- 棄用的退回方案：儲存的舊有工作若 `notify: true`，在 `cron.webhook` 存在時仍會使用它。

完全停用 cron：

- `cron.enabled: false` (配置)
- `OPENCLAW_SKIP_CRON=1` (環境變數)

## 維護

Cron 具備兩條內建維護路徑：隔離執行會話保留與執行日誌修剪。

### 預設值

- `cron.sessionRetention`：`24h`（設定為 `false` 以停用執行會話修剪）
- `cron.runLog.maxBytes`：`2,000,000` 位元組
- `cron.runLog.keepLines`：`2000`

### 運作方式

- 隔離執行會建立會話項目（`...:cron:<jobId>:run:<uuid>`）與逐字稿檔案。
- 清除器會移除早於 `cron.sessionRetention` 的過期執行會話項目。
- 對於會話儲存不再引用的已移除執行會話，OpenClaw 會封存逐字稿檔案，並在相同的保留窗口內清除舊的已刪除封存檔。
- 在每次執行附加後，會檢查 `cron/runs/<jobId>.jsonl` 的大小：
  - 如果檔案大小超過 `runLog.maxBytes`，則會修剪為最新的 `runLog.keepLines` 行。

### 高量排程器的效能警告

高頻率的 cron 設定可能會產生龐大的執行會話與執行日誌磁碟佔用。維護功能雖已內建，但寬鬆的限制仍可能造成不必要的 IO 與清理工作。

注意事項：

- 帶有許多隔離執行的長 `cron.sessionRetention` 窗口
- 高 `cron.runLog.keepLines` 結合大 `runLog.maxBytes`
- 許多嘈雜的重複工作寫入同一個 `cron/runs/<jobId>.jsonl`

建議做法：

- 根據您的除錯/稽核需求，盡可能縮短 `cron.sessionRetention` 窗口
- 透過適度的 `runLog.maxBytes` 與 `runLog.keepLines` 限制執行日誌大小
- 將嘈雜的背景工作改為隔離模式，並搭配避免不必要碎嘴的傳遞規則
- 定期使用 `openclaw cron runs` 檢視增長情況，並在日誌變大前調整保留設定

### 自訂範例

保留執行會話一週，並允許較大的執行日誌：

```json5
{
  cron: {
    sessionRetention: "7d",
    runLog: {
      maxBytes: "10mb",
      keepLines: 5000,
    },
  },
}
```

停用隔離執行會話修剪，但保留執行日誌修剪：

```json5
{
  cron: {
    sessionRetention: false,
    runLog: {
      maxBytes: "5mb",
      keepLines: 3000,
    },
  },
}
```

針對高量 cron 使用量進行調優（範例）：

```json5
{
  cron: {
    sessionRetention: "12h",
    runLog: {
      maxBytes: "3mb",
      keepLines: 1500,
    },
  },
}
```

## CLI 快速開始

單次提醒（UTC ISO，成功後自動刪除）：

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

單次提醒（主會話，立即喚醒）：

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

重複性隔離工作（宣告至 WhatsApp）：

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

具備明確 30 秒交錯的重複性 cron 工作：

```bash
openclaw cron add \
  --name "Minute watcher" \
  --cron "0 * * * * *" \
  --tz "UTC" \
  --stagger 30s \
  --session isolated \
  --message "Run minute watcher checks." \
  --announce
```

重複性隔離工作（傳遞至 Telegram 討論串）：

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

具備模型與思考覆蓋的隔離工作：

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

代理選擇（多代理設定）：

```bash
# 將工作釘選至代理 "ops"（若該代理缺失則退回預設值）
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 切換或清除現有工作的代理
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手動執行（預設為強制，使用 `--due` 僅在到期時執行）：

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

`cron.run` 現在會在手動執行進入佇列後立即確認，而非在工作結束後。成功的佇列回應看起來像 `{ ok: true, enqueued: true, runId }`。如果工作已經在執行中或 `--due` 發現未到期，回應則為 `{ ok: true, ran: false, reason }`。請使用 `openclaw cron runs --id <jobId>` 或 `cron.runs` 閘道方法來檢查最終完成的項目。

編輯現有工作 (patch 欄位)：

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

強制現有 cron 工作精確按排程執行（無交錯）：

```bash
openclaw cron edit <jobId> --exact
```

執行歷史紀錄：

```bash
openclaw cron runs --id <jobId> --limit 50
```

不建立工作的情況下發送立即系統事件：

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## 閘道 API 介面

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (強制或到期), `cron.runs`
  對於無須工作的立即系統事件，請使用 [`openclaw system event`](/cli/system)。

## 故障排除

### 「沒有東西在執行」

- 檢查 cron 是否已啟用：`cron.enabled` 與 `OPENCLAW_SKIP_CRON`。
- 檢查閘道是否持續執行中（cron 在閘道程序內部執行）。
- 對於 `cron` 排程：確認時區 (`--tz`) 與主機時區。

### 失敗後重複性的工作持續延遲

- OpenClaw 在連續錯誤後，對重複性工作套用指數重試退避：
  重試之間間隔 30s, 1m, 5m, 15m, 然後 60m。
- 退避會在下一次成功執行後自動重設。
- 單次 (`at`) 工作會針對暫時性錯誤（速率限制、過載、網路、伺服器錯誤）重試最多 3 次並帶有退避；永久性錯誤則立即停用。參見 [重試策略](/automation/cron-jobs#retry-policy)。

### Telegram 傳遞到錯誤的地方

- 對於論壇討論串，請使用 `-100…:topic:<id>` 以確保明確且無歧義。
- 如果您在日誌或儲存的「最後路由」目標中看到 `telegram:...` 前綴，這是正常的；
  cron 傳遞接受這些前綴並仍能正確解析討論串 ID。

### 子代理宣告傳遞重試 (Subagent announce delivery retries)

- 當子代理執行完成時，閘道會向請求者會話宣告結果。
- 如果宣告流程傳回 `false`（例如請求者會話忙碌中），閘道會透過 `announceRetryCount` 追蹤並重試最多 3 次。
- 超過 `endedAt` 5 分鐘的宣告將被強制過期，以防止過時項目無限迴圈。
- 如果您在日誌中看到重複的宣告傳遞，請檢查子代理登錄檔中具有高 `announceRetryCount` 值的項目。
