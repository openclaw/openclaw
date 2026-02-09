---
summary: "Gateway 排程器的 Cron 工作 + 喚醒"
read_when:
  - 排程背景工作或喚醒
  - 串接應與心跳一起或並行執行的自動化
  - 在排程任務中決定使用心跳或 Cron
title: "Cron 工作"
---

# Cron 工作（Gateway 排程器）

> **Cron vs Heartbeat？** 請參考 [Cron vs Heartbeat](/automation/cron-vs-heartbeat)，了解各自的使用時機。

Cron 是 Gateway 內建的排程器。它會保存工作、在正確時間喚醒代理程式，並可選擇將輸出回傳到聊天。 It persists jobs, wakes the agent at
the right time, and can optionally deliver output back to a chat.

如果你想要「每天早上執行一次」或「20 分鐘後戳一下代理程式」，Cron 就是這個機制。

疑難排解：[/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron **在 Gateway 內執行**（不在模型內）。
- 工作會保存在 `~/.openclaw/cron/`，因此重新啟動不會遺失排程。
- 兩種執行方式：
  - **主工作階段**：排入一個系統事件，接著在下一次心跳執行。
  - **隔離**：在 `cron:<jobId>` 中執行專用的代理程式回合，並可設定傳遞方式（預設公告或不傳遞）。
- 喚醒是第一級功能：工作可要求「立即喚醒」或「下一次心跳」。

## 快速開始（可操作）

建立一次性提醒、確認它存在，並立即執行：

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

排程一個具有傳遞的循環隔離工作：

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

## 工具呼叫對應（Gateway cron 工具）

關於標準 JSON 結構與範例，請參閱 [工具呼叫的 JSON schema](/automation/cron-jobs#json-schema-for-tool-calls)。

## Cron 工作的儲存位置

Cron 工作預設會儲存在 Gateway 閘道器主機的 `~/.openclaw/cron/jobs.json`。
Gateway 會將檔案載入記憶體，並在變更時寫回，因此只有在 Gateway 停止時手動編輯才安全。請優先使用 `openclaw cron add/edit` 或 cron 工具呼叫 API 進行變更。
The Gateway loads the file into memory and writes it back on changes, so manual edits
are only safe when the Gateway is stopped. Prefer `openclaw cron add/edit` or the cron
tool call API for changes.

## 新手友善概覽

將一個 Cron 工作想成：**何時** 執行 + **做什麼**。

1. **選擇排程**
   - 一次性提醒 → `schedule.kind = "at"`（CLI：`--at`）
   - 重複性工作 → `schedule.kind = "every"` 或 `schedule.kind = "cron"`
   - 若 ISO 時間戳未包含時區，會視為 **UTC**。

2. **選擇執行位置**
   - `sessionTarget: "main"` → 在下一次心跳期間以主上下文執行。
   - `sessionTarget: "isolated"` → 在 `cron:<jobId>` 中執行專用的代理程式回合。

3. **選擇負載**
   - 主工作階段 → `payload.kind = "systemEvent"`
   - 隔離工作階段 → `payload.kind = "agentTurn"`

可選項：一次性工作（`schedule.kind = "at"`）預設在成功後刪除。設定 `deleteAfterRun: false` 可保留它們（成功後會停用）。 Set
`deleteAfterRun: false` to keep them (they will disable after success).

## 概念

### 工作

一個 Cron 工作是包含下列項目的儲存紀錄：

- **排程**（何時執行），
- a **payload** (what it should do),
- 可選的 **傳遞模式**（公告或無）。
- optional **agent binding** (`agentId`): run the job under a specific agent; if
  missing or unknown, the gateway falls back to the default agent.

Jobs are identified by a stable `jobId` (used by CLI/Gateway APIs).
In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.
One-shot jobs auto-delete after success by default; set `deleteAfterRun: false` to keep them.

### 排程

Cron 支援三種排程類型：

- `at`：透過 `schedule.at`（ISO 8601）的一次性時間戳。
- `every`：固定間隔（毫秒）。
- `cron`：5 欄位 Cron 表達式，可選 IANA 時區。

Cron expressions use `croner`. If a timezone is omitted, the Gateway host’s
local timezone is used.

### 主工作階段 vs 隔離執行

#### 主工作階段工作（系統事件）

Main jobs enqueue a system event and optionally wake the heartbeat runner.
主工作會排入一個系統事件，並可選擇喚醒心跳執行器。
它們必須使用 `payload.kind = "systemEvent"`。

- `wakeMode: "now"`（預設）：事件會觸發立即的心跳執行。
- `wakeMode: "next-heartbeat"`：事件會等待下一次排定的心跳。

This is the best fit when you want the normal heartbeat prompt + main-session context.
See [Heartbeat](/gateway/heartbeat).

#### 隔離工作（專用 Cron 工作階段）

隔離工作會在工作階段 `cron:<jobId>` 中執行專用的代理程式回合。

關鍵行為：

- 提示詞會加上 `[cron:<jobId> <job name>]` 前綴以利追蹤。
- 每次執行都會建立 **全新的工作階段 ID**（不會沿用先前對話）。
- 預設行為：若省略 `delivery`，隔離工作會公告一則摘要（`delivery.mode = "announce"`）。
- `delivery.mode`（僅限隔離）決定行為：
  - `announce`：將摘要傳遞至目標頻道，並在主工作階段發佈簡短摘要。
  - `none`: internal only (no delivery, no main-session summary).
- `wakeMode` 控制主工作階段摘要的發佈時機：
  - `now`：立即心跳。
  - `next-heartbeat`：等待下一次排定的心跳。

將隔離工作用於嘈雜、頻繁或「背景雜務」，避免汙染主聊天紀錄。

### Payload shapes (what runs)

支援兩種負載類型：

- `systemEvent`：僅主工作階段，透過心跳提示詞路由。
- `agentTurn`：僅隔離工作階段，執行專用代理程式回合。

通用的 `agentTurn` 欄位：

- `message`：必填的文字提示。
- `model` / `thinking`：可選覆寫（見下方）。
- `timeoutSeconds`：可選的逾時覆寫。

傳遞設定（僅隔離工作）：

- `delivery.mode`：`none` | `announce`。
- `delivery.channel`：`last` 或指定頻道。
- `delivery.to`：頻道專屬的目標（電話 / 聊天 / 頻道 ID）。
- `delivery.bestEffort`：若公告傳遞失敗，避免使工作失敗。

公告傳遞會抑制該次執行中的訊息工具發送；請使用 `delivery.channel` / `delivery.to` 直接指向聊天。當 `delivery.mode = "none"` 時，不會向主工作階段發佈摘要。 When `delivery.mode = "none"`, no summary is posted to the main session.

若隔離工作省略 `delivery`，OpenClaw 會預設為 `announce`。

#### Announce delivery flow

當 `delivery.mode = "announce"` 時，Cron 會透過對外頻道轉接器直接傳遞。
主代理程式不會被啟動來撰寫或轉送訊息。
The main agent is not spun up to craft or forward the message.

行為細節：

- 內容：傳遞會使用隔離執行的對外負載（文字 / 媒體），並套用正常的分塊與頻道格式。
- Heartbeat-only responses (`HEARTBEAT_OK` with no real content) are not delivered.
- 若隔離執行已透過訊息工具向相同目標發送訊息，為避免重複，將跳過傳遞。
- 缺失或無效的傳遞目標會使工作失敗，除非設定 `delivery.bestEffort = true`。
- 只有在 `delivery.mode = "announce"` 時，才會向主工作階段發佈簡短摘要。
- 主工作階段摘要遵循 `wakeMode`：`now` 會觸發立即心跳，而 `next-heartbeat` 會等待下一次排定的心跳。

### 模型與思考層級覆寫

隔離工作（`agentTurn`）可以覆寫模型與思考層級：

- `model`：提供者 / 模型字串（例如 `anthropic/claude-sonnet-4-20250514`）或別名（例如 `opus`）
- `thinking`：思考層級（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`；僅 GPT-5.2 + Codex 模型）

Note: You can set `model` on main-session jobs too, but it changes the shared main
session model. We recommend model overrides only for isolated jobs to avoid
unexpected context shifts.

解析優先順序：

1. Job payload override (highest)
2. Hook 專屬預設（例如 `hooks.gmail.model`）
3. 代理程式設定預設

### 傳遞（頻道 + 目標）

隔離工作可透過最上層的 `delivery` 設定，將輸出傳遞至頻道：

- `delivery.mode`：`announce`（傳遞摘要）或 `none`。
- `delivery.channel`：`whatsapp` / `telegram` / `discord` / `slack` / `mattermost`（plugin） / `signal` / `imessage` / `last`。
- `delivery.to`：頻道專屬的收件者目標。

傳遞設定僅適用於隔離工作（`sessionTarget: "isolated"`）。

若省略 `delivery.channel` 或 `delivery.to`，Cron 可回退到主工作階段的「最後路由」（代理程式最後回覆的位置）。

目標格式提醒：

- Slack / Discord / Mattermost（plugin）目標應使用明確前綴（例如 `channel:<id>`、`user:<id>`）以避免歧義。
- Telegram 主題應使用 `:topic:` 形式（見下方）。

#### Telegram 傳遞目標（主題 / 討論串）

Telegram 透過 `message_thread_id` 支援論壇主題。對於 Cron 傳遞，你可以將主題 / 討論串編碼到 `to` 欄位： For cron delivery, you can encode
the topic/thread into the `to` field:

- `-1001234567890`（僅聊天 ID）
- `-1001234567890:topic:123`（建議：明確的主題標記）
- `-1001234567890:123`（簡寫：數字後綴）

也接受像 `telegram:...` / `telegram:group:...` 這類帶前綴的目標：

- `telegram:group:-1001234567890:topic:123`

## 工具呼叫的 JSON schema

Use these shapes when calling Gateway `cron.*` tools directly (agent tool calls or RPC).
直接呼叫 Gateway `cron.*` 工具（代理程式工具呼叫或 RPC）時，請使用以下結構。
CLI 旗標可接受如 `20m` 的人類可讀時間，但工具呼叫應對 `schedule.at` 使用 ISO 8601 字串，並對 `schedule.everyMs` 使用毫秒。

### cron.add 參數

一次性、主工作階段工作（系統事件）：

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

循環、隔離工作（含傳遞）：

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

注意事項：

- `schedule.kind`：`at`（`at`）、`every`（`everyMs`），或 `cron`（`expr`，可選 `tz`）。
- `schedule.at` 接受 ISO 8601（時區可選；省略時視為 UTC）。
- `everyMs` 為毫秒。
- `sessionTarget` 必須為 `"main"` 或 `"isolated"`，且必須與 `payload.kind` 相符。
- 可選欄位：`agentId`、`description`、`enabled`、`deleteAfterRun`（`at` 預設為 true）、`delivery`。
- 省略時，`wakeMode` 預設為 `"now"`。

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

注意事項：

- `jobId` 為標準；為相容性也接受 `id`。
- 在 patch 中使用 `agentId: null` 以清除代理程式綁定。

### cron.run 與 cron.remove 參數

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 儲存與歷史

- 工作儲存：`~/.openclaw/cron/jobs.json`（Gateway 管理的 JSON）。
- 執行歷史：`~/.openclaw/cron/runs/<jobId>.jsonl`（JSONL，會自動修剪）。
- 覆寫儲存路徑：設定中的 `cron.store`。

## 設定

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

完全停用 Cron：

- `cron.enabled: false`（設定）
- `OPENCLAW_SKIP_CRON=1`（環境變數）

## CLI 快速開始

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

一次性提醒（主工作階段，立即喚醒）：

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

循環隔離工作（公告至 WhatsApp）：

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

循環隔離工作（傳遞至 Telegram 主題）：

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

含模型與思考覆寫的隔離工作：

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

代理程式選擇（多代理程式設定）：

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手動執行（預設為 force，使用 `--due` 以僅在到期時執行）：

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

編輯既有工作（修補欄位）：

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

執行歷史：

```bash
openclaw cron runs --id <jobId> --limit 50
```

不建立工作即可觸發立即的系統事件：

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API 介面

- `cron.list`、`cron.status`、`cron.add`、`cron.update`、`cron.remove`
- `cron.run`（force 或 due）、`cron.runs`
  若需不建立工作的立即系統事件，請使用 [`openclaw system event`](/cli/system)。

## Troubleshooting

### 「什麼都沒有執行」

- 檢查是否已啟用 Cron：`cron.enabled` 與 `OPENCLAW_SKIP_CRON`。
- 確認 Gateway 持續執行（Cron 在 Gateway 行程內執行）。
- 對於 `cron` 排程：確認時區（`--tz`）與主機時區是否一致。

### 循環工作在失敗後持續延遲

- OpenClaw applies exponential retry backoff for recurring jobs after consecutive errors:
  30s, 1m, 5m, 15m, then 60m between retries.
- 在下一次成功執行後，退避會自動重置。
- 一次性（`at`）工作在終止性執行後（`ok`、`error` 或 `skipped`）會停用，且不會重試。

### Telegram 傳遞到錯誤的位置

- 對於論壇主題，請使用 `-100…:topic:<id>`，以確保明確且不含歧義。
- 若你在日誌或儲存的「最後路由」目標中看到 `telegram:...` 前綴，這是正常的；
  Cron 傳遞接受它們，並仍會正確解析主題 ID。
