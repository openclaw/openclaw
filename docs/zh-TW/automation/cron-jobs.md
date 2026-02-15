---
summary: "Gateway 排程器的排程工作與喚醒功能"
read_when:
  - 排程背景工作或喚醒
  - 串接應隨心跳執行或與其併行的自動化
  - 在心跳與排程之間決定排程任務的處理方式
title: "排程工作 (Cron Jobs)"
---

# 排程工作 (Gateway 排程器)

> **Cron vs Heartbeat？** 請參閱 [Cron vs Heartbeat](/automation/cron-vs-heartbeat) 以獲取使用時機的指引。

Cron 是 Gateway 內建的排程器。它可以持久化工作、在正確的時間喚醒 Agent，並可選擇將輸出傳送回聊天視窗。

如果您想要「每天早上執行」或「在 20 分鐘後提醒 Agent」，Cron 就是實現此機制的工具。

疑難排解：[/automation/troubleshooting](/automation/troubleshooting)

## 摘要 (TL;DR)

- Cron 在 **Gateway 內部**執行（而非模型內部）。
- 工作會儲存在 `~/.openclaw/cron/` 下，因此重新啟動不會丟失排程。
- 兩種執行風格：
  - **主對話階段 (Main session)**：將系統事件排入佇列，然後在下一次心跳時執行。
  - **獨立執行 (Isolated)**：在 `cron:<jobId>` 中執行專用的 Agent 輪次，並進行傳送（預設為宣告或無）。
- 喚醒功能是一等公民：工作可以要求「立即喚醒」或「下一次心跳」。

## 快速開始（可操作）

建立一個一次性提醒，驗證其是否存在，並立即執行：

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

排程一個帶有傳送功能的週期性獨立工作：

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

## 工具呼叫對應物 (Gateway cron 工具)

有關規範的 JSON 形式和範例，請參閱 [工具呼叫的 JSON 結構描述](/automation/cron-jobs#json-schema-for-tool-calls)。

## 排程工作儲存位置

排程工作預設會持久化在 Gateway 主機的 `~/.openclaw/cron/jobs.json` 中。
Gateway 會將檔案載入記憶體，並在變更時寫回，因此僅在 Gateway 停止時才可安全地手動編輯。建議優先使用 `openclaw cron add/edit` 或 cron 工具呼叫 API 進行更改。

## 入門指引

將排程工作想像成：**何時**執行 + **做什麼**事。

1. **選擇排程**
   - 一次性提醒 → `schedule.kind = "at"` (CLI: `--at`)
   - 重複性工作 → `schedule.kind = "every"` 或 `schedule.kind = "cron"`
   - 如果您的 ISO 時間戳記省略了時區，它會被視為 **UTC**。

2. **選擇執行位置**
   - `sessionTarget: "main"` → 在下一次心跳期間使用主內容執行。
   - `sessionTarget: "isolated"` → 在 `cron:<jobId>` 中執行專用的 Agent 輪次。

3. **選擇有效負載 (Payload)**
   - 主對話階段 → `payload.kind = "systemEvent"`
   - 獨立對話階段 → `payload.kind = "agentTurn"`

選配：一次性工作（`schedule.kind = "at"`）預設在成功後刪除。設定 `deleteAfterRun: false` 以保留它們（成功後它們會變為停用狀態）。

## 概念

### 工作 (Jobs)

排程工作是一條儲存的記錄，包含：

- **排程**（何時執行）、
- **有效負載**（要做什麼）、
- 選配的 **傳送模式**（宣告或無）。
- 選配的 **Agent 綁定** (`agentId`)：在特定 Agent 下執行工作；如果缺失或未知，Gateway 會退回到預設 Agent。

工作由穩定的 `jobId` 識別（供 CLI/Gateway API 使用）。
在 Agent 工具呼叫中，`jobId` 是規範用法；為了相容性也接受舊版的 `id`。
一次性工作預設在成功後自動刪除；設定 `deleteAfterRun: false` 可保留。

### 排程 (Schedules)

Cron 支援三種排程類型：

- `at`：透過 `schedule.at` (ISO 8601) 設定的一次性時間戳記。
- `every`：固定間隔（毫秒）。
- `cron`：具有選配 IANA 時區的 5 欄位 cron 表達式。

Cron 表達式使用 `croner`。如果省略時區，則使用 Gateway 主機的在地時區。

### 主對話 vs 獨立執行

#### 主對話階段工作（系統事件）

主對話工作會將系統事件排入佇列，並可選擇喚醒心跳執行器。
它們必須使用 `payload.kind = "systemEvent"`。

- `wakeMode: "now"`（預設）：事件會觸發立即的心跳執行。
- `wakeMode: "next-heartbeat"`：事件會等待下一個預定的心跳。

當您想要使用正常的心跳提示詞 + 主對話階段內容時，這是最佳選擇。
請參閱 [心跳 (Heartbeat)](/gateway/heartbeat)。

#### 獨立工作（專用 Cron 對話階段）

獨立工作會在對話階段 `cron:<jobId>` 中執行專用的 Agent 輪次。

關鍵行為：

- 提示詞會加上 `[cron:<jobId> <job name>]` 前綴以便追蹤。
- 每次執行都會啟動一個 **全新的對話階段 ID**（不會繼承之前的對話內容）。
- 預設行為：如果省略 `delivery`，獨立工作會宣告摘要 (`delivery.mode = "announce"`)。
- `delivery.mode`（僅限獨立工作）決定發生的情況：
  - `announce`：將摘要傳送到目標通道，並在主對話階段發佈簡短摘要。
  - `none`：僅限內部（不傳送，無主對話階段摘要）。
- `wakeMode` 控制主對話階段摘要發佈的時間：
  - `now`：立即執行心跳。
  - `next-heartbeat`：等待下一個預定的心跳。

針對雜亂、頻繁或「背景瑣事」，請使用獨立執行工作，以免洗版您的主聊天紀錄。

### 有效負載形式（執行內容）

支援兩種有效負載類型：

- `systemEvent`：僅限主對話階段，透過心跳提示詞路由。
- `agentTurn`：僅限獨立對話階段，執行專用的 Agent 輪次。

常見的 `agentTurn` 欄位：

- `message`：必要的文字提示詞。
- `model` / `thinking`：選配的覆寫項（見下文）。
- `timeoutSeconds`：選配的逾時覆寫。

傳送設定（僅限獨立工作）：

- `delivery.mode`: `none` | `announce`。
- `delivery.channel`: `last` 或特定通道。
- `delivery.to`: 針對通道的目標（電話/聊天/通道 ID）。
- `delivery.bestEffort`: 如果宣告傳送失敗，避免使工作失敗。

宣告傳送會抑制該次執行的訊息工具發送；請改用 `delivery.channel`/`delivery.to` 來指定聊天目標。當 `delivery.mode = "none"` 時，不會在主對話階段發佈摘要。

如果獨立工作省略了 `delivery`，OpenClaw 預設會使用 `announce`。

#### 宣告傳送流程

當 `delivery.mode = "announce"` 時，Cron 會透過出站通道適配器直接傳送。
主 Agent 不會啟動來編寫或轉發訊息。

行為細節：

- 內容：傳送使用獨立執行的出站有效負載（文字/媒體），並進行正常的分段和通道格式化。
- 僅心跳回應（`HEARTBEAT_OK` 且無實質內容）不會傳送。
- 如果獨立執行已經透過訊息工具向同一目標發送了訊息，則會跳過傳送以避免重複。
- 除非 `delivery.bestEffort = true`，否則缺失或無效的傳送目標會導致工作失敗。
- 僅在 `delivery.mode = "announce"` 時，才會在主對話階段發佈短摘要。
- 主對話階段摘要遵循 `wakeMode`：`now` 會觸發立即的心跳，而 `next-heartbeat` 會等待下一個預定的心跳。

### 模型與思考覆寫

獨立工作 (`agentTurn`) 可以覆寫模型和思考等級：

- `model`：提供者/模型字串（例如 `anthropic/claude-sonnet-4-20250514`）或別名（例如 `opus`）
- `thinking`：思考等級（`off`, `minimal`, `low`, `medium`, `high`, `xhigh`；僅限 GPT-5.2 + Codex 模型）

注意：您也可以在主對話階段工作上設定 `model`，但這會更改共享的主對話階段模型。我們建議僅對獨立工作使用模型覆寫，以避免非預期的內容切換。

解析優先順序：

1. 工作有效負載覆寫（最高）
2. Hook 特定預設值（例如 `hooks.gmail.model`）
3. Agent 設定預設值

### 傳送（通道 + 目標）

獨立工作可以透過頂層的 `delivery` 設定將輸出傳送到通道：

- `delivery.mode`: `announce`（傳送摘要）或 `none`。
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (外掛) / `signal` / `imessage` / `last`。
- `delivery.to`: 通道特定的接收者目標。

傳送設定僅對獨立工作 (`sessionTarget: "isolated"`) 有效。

如果省略 `delivery.channel` 或 `delivery.to`，Cron 可以退回到主對話階段的「最後路由」（Agent 上次遞送的地點）。

目標格式提醒：

- Slack/Discord/Mattermost (外掛) 目標應使用明確的前綴（例如 `channel:<id>`, `user:<id>`）以避免歧義。
- Telegram 主題應使用 `:topic:` 形式（見下文）。

#### Telegram 傳送目標（主題 / 論壇討論串）

Telegram 透過 `message_thread_id` 支援論壇主題。對於 Cron 傳送，您可以將主題/討論串編碼到 `to` 欄位中：

- `-1001234567890`（僅限聊天 ID）
- `-1001234567890:topic:123`（推薦：明確的主題標記）
- `-1001234567890:123`（簡寫：數字字尾）

也接受帶有前綴的目標，如 `telegram:...` / `telegram:group:...`：

- `telegram:group:-1001234567890:topic:123`

## 工具呼叫的 JSON 結構描述

直接呼叫 Gateway `cron.*` 工具（Agent 工具呼叫或 RPC）時請使用這些形式。CLI 旗標接受像 `20m` 這樣的人性化時長，但工具呼叫應為 `schedule.at` 使用 ISO 8601 字串，並為 `schedule.everyMs` 使用毫秒。

### cron.add 參數

一次性、主對話階段工作（系統事件）：

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

重複性、帶有傳送功能的獨立工作：

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
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

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), 或 `cron` (`expr`, 選配 `tz`)。
- `schedule.at` 接受 ISO 8601（時區選配；省略時視為 UTC）。
- `everyMs` 單位為毫秒。
- `sessionTarget` 必須為 `"main"` 或 `"isolated"`，且必須與 `payload.kind` 匹配。
- 選配欄位：`agentId`, `description`, `enabled`, `deleteAfterRun`（對於 `at` 預設為 true）, `delivery`。
- 省略時 `wakeMode` 預設為 `"now"`。

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

- `jobId` 是規範用法；也接受 `id` 以進行相容。
- 在 patch 中使用 `agentId: null` 可清除 Agent 綁定。

### cron.run 與 cron.remove 參數

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 儲存與紀錄

- 工作儲存：`~/.openclaw/cron/jobs.json`（由 Gateway 管理的 JSON）。
- 執行紀錄：`~/.openclaw/cron/runs/<jobId>.jsonl`（JSONL，自動清理）。
- 覆寫儲存路徑：設定中的 `cron.store`。

## 設定

```json5
{
  cron: {
    enabled: true, // 預設為 true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // 預設為 1
  },
}
```

完全停用 Cron：

- `cron.enabled: false` (設定)
- `OPENCLAW_SKIP_CRON=1` (環境變數)

## CLI 快速上手

一次性提醒（UTC ISO，成功後自動刪除）：

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

一次性提醒（主對話階段，立即喚醒）：

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

重複性獨立工作（宣告到 WhatsApp）：

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

重複性獨立工作（傳送到 Telegram 主題）：

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

帶有模型與思考覆寫的獨立工作：

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

Agent 選擇（多 Agent 設定）：

```bash
# 將工作固定到 Agent "ops"（如果該 Agent 缺失則退回到預設值）
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 切換或清除現有工作上的 Agent
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手動執行（預設為強制執行，使用 `--due` 則僅在到期時執行）：

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

編輯現有工作（補丁欄位）：

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

執行紀錄：

```bash
openclaw cron runs --id <jobId> --limit 50
```

不建立工作的立即系統事件：

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API 介面

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run`（強制或到期）, `cron.runs`
  對於不帶工作的立即系統事件，請使用 [`openclaw system event`](/cli/system)。

## 疑難排解

### 「沒有任何東西在執行」

- 檢查 Cron 是否已啟用：`cron.enabled` 和 `OPENCLAW_SKIP_CRON`。
- 檢查 Gateway 是否持續執行（Cron 在 Gateway 程序內部執行）。
- 對於 `cron` 排程：確認時區 (`--tz`) 與主機時區的對比。

### 重複性工作在失敗後持續延遲

- 對於連續錯誤的重複性工作，OpenClaw 會套用指數型退避重試：
  重試之間間隔 30 秒、1 分鐘、5 分鐘、15 分鐘，然後是 60 分鐘。
- 退避會在下一次成功執行後自動重設。
- 一次性 (`at`) 工作在終端執行（`ok`、`error` 或 `skipped`）後會停用，且不會重試。

### Telegram 傳送到錯誤的位置

- 對於論壇主題，請使用 `-100…:topic:<id>`，使其明確且無歧義。
- 如果您在日誌或儲存的「最後路由」目標中看到 `telegram:...` 前綴，這是正常的；
  Cron 傳送接受它們，並且仍能正確解析主題 ID。
