```
---
summary: "Cron 工作排程 + Gateway 排程器的喚醒功能"
read_when:
  - 排定背景工作或喚醒功能時
  - 串接應與心跳訊號一同執行或搭配執行的自動化時
  - 決定排程任務使用心跳訊號還是 cron 時
title: "Cron 工作排程"
---

# Cron 工作排程 (Gateway 排程器)

> **Cron 與心跳訊號的比較？** 請參閱[Cron 與心跳訊號](/automation/cron-vs-heartbeat)以了解何時使用兩者。

Cron 是 Gateway 內建的排程器。它會儲存工作排程、在正確的時間喚醒代理程式，並且可以選擇性地將輸出訊息傳遞回聊天室。

如果您想要 _「每天早上執行此操作」_ 或 _「在 20 分鐘後觸發代理程式」_，cron 就是實現此目的的機制。

疑難排解：[/automation/troubleshooting](/automation/troubleshooting)

## 重點摘要

- Cron 在 **Gateway 內部**執行 (而非模型內部)。
- 工作排程會儲存在 `~/.openclaw/cron/` 下，因此重新啟動不會遺失排程。
- 兩種執行方式：
  - **主要會話**: 將系統事件排入佇列，然後在下一次心跳訊號時執行。
  - **隔離**: 在 `cron:<jobId>` 中執行專用的代理程式輪次，並帶有傳遞功能 (預設為公告，或不傳遞)。
- 喚醒功能是首要的：工作排程可以請求「立即喚醒」與「下一次心跳訊號時喚醒」。

## 快速入門 (可操作)

建立一次性提醒、驗證其是否存在，然後立即執行：

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

排定一個帶有傳遞功能的重複隔離工作排程：

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

## 工具呼叫的等效功能 (Gateway cron 工具)

有關標準 JSON 格式和範例，請參閱[工具呼叫的 JSON 綱要](/automation/cron-jobs#json-schema-for-tool-calls)。

## Cron 工作排程的儲存位置

Cron 工作排程預設儲存在 Gateway 主機的 `~/.openclaw/cron/jobs.json`。Gateway 會將檔案載入記憶體並在變更時寫回，因此手動編輯僅在 Gateway 停止時才是安全的。建議使用 `openclaw cron add/edit` 或 cron 工具呼叫 API 進行變更。

## 初學者友善概覽

將 cron 工作排程視為：**何時**執行 + **要做什麼**。

1.  **選擇排程**
    -   一次性提醒 → `schedule.kind = "at"` (CLI: `--at`)
    -   重複工作排程 → `schedule.kind = "every"` 或 `schedule.kind = "cron"`
    -   如果您的 ISO 時間戳記省略了時區，則會被視為 **UTC**。

2.  **選擇執行位置**
    -   `sessionTarget: "main"` → 在下一次心跳訊號時，以主要情境執行。
    -   `sessionTarget: "isolated"` → 在 `cron:<jobId>` 中執行專用的代理程式輪次。

3.  **選擇酬載**
    -   主要會話 → `payload.kind = "systemEvent"`
    -   隔離會話 → `payload.kind = "agentTurn"`

選填：一次性工作排程 (`schedule.kind = "at"`) 預設在成功後刪除。設定
`deleteAfterRun: false` 以保留它們 (它們會在成功後停用)。

## 概念

### 工作排程

cron 工作排程是一個儲存的紀錄，包含：

-   **排程** (何時執行)，
-   **酬載** (要做什麼)，
-   選填的**傳遞模式** (公告或不傳遞)。
-   選填的**代理程式綁定** (`agentId`)：在特定代理程式下執行工作排程；如果
    缺少或未知，Gateway 會回退到預設代理程式。

工作排程由穩定的 `jobId` 識別 (CLI/Gateway API 使用)。
在代理程式工具呼叫中，`jobId` 是規範的；為了相容性，也接受舊版的 `id`。
一次性工作排程預設在成功後自動刪除；設定 `deleteAfterRun: false` 以保留它們。

### 排程

Cron 支援三種排程類型：

-   `at`：透過 `schedule.at` 的一次性時間戳記 (ISO 8601)。
-   `every`：固定間隔 (毫秒)。
-   `cron`：包含選填 IANA 時區的 5 欄位 cron 表達式。

Cron 表達式使用 `croner`。如果省略時區，則使用 Gateway 主機的當地時區。

### 主要會話與隔離會話執行

#### 主要會話工作排程 (系統事件)

主要工作排程會將系統事件排入佇列，並可選擇性地喚醒心跳訊號執行器。
它們必須使用 `payload.kind = "systemEvent"`。

-   `wakeMode: "now"` (預設)：事件觸發立即的心跳訊號執行。
-   `wakeMode: "next-heartbeat"`：事件等待下一次排定的心跳訊號。

當您想要正常的心跳訊號提示 + 主要會話情境時，這是最佳選擇。
請參閱[心跳訊號](/gateway/heartbeat)。

#### 隔離工作排程 (專用 cron 會話)

隔離工作排程在會話 `cron:<jobId>` 中執行專用的代理程式輪次。

主要行為：

-   提示會以 `[cron:<jobId> <工作排程名稱>]` 為前綴，以便追溯。
-   每次執行都會啟動**新的會話 ID** (沒有先前的對話延續)。
-   預設行為：如果省略 `delivery`，隔離工作排程會公告摘要 (`delivery.mode = "announce"`)。
-   `delivery.mode` (僅限隔離) 選擇會發生什麼：
    -   `announce`：將摘要傳遞到目標通道，並將簡短摘要發佈到主要會話。
    -   `none`：僅限內部 (不傳遞，無主要會話摘要)。
-   `wakeMode` 控制主要會話摘要發佈的時間：
    -   `now`：立即心跳訊號。
    -   `next-heartbeat`：等待下一次排定的心跳訊號。

將隔離工作排程用於嘈雜、頻繁或「背景雜務」，這些雜務不應在您的主要聊天記錄中產生垃圾訊息。

### 酬載格式 (執行什麼)

支援兩種酬載類型：

-   `systemEvent`：僅限主要會話，透過心跳訊號提示路由。
-   `agentTurn`：僅限隔離會話，執行專用的代理程式輪次。

常見 `agentTurn` 欄位：

-   `message`：必要的文字提示。
-   `model` / `thinking`：選填的覆寫 (請參閱下方)。
-   `timeoutSeconds`：選填的逾時覆寫。

傳遞設定 (僅限隔離工作排程)：

-   `delivery.mode`：`none` | `announce`。
-   `delivery.channel`：`last` 或特定通道。
-   `delivery.to`：通道特定目標 (電話/聊天/通道 ID)。
-   `delivery.bestEffort`：如果公告傳遞失敗，則避免工作排程失敗。

公告傳遞會抑制執行期間的訊息工具傳送；請改用 `delivery.channel`/`delivery.to`
來指定聊天目標。當 `delivery.mode = "none"` 時，不會將摘要發佈到主要會話。

如果隔離工作排程省略 `delivery`，OpenClaw 預設為 `announce`。

#### 公告傳遞流程

當 `delivery.mode = "announce"` 時，cron 會直接透過 outbound 通道配接器進行傳遞。
主代理程式不會啟動來製作或轉發訊息。

行為詳情：

-   內容：傳遞使用隔離執行的 outbound 酬載 (文字/媒體)，並採用正常的區塊化和
    通道格式。
-   僅限心跳訊號的回應 (無實際內容的 `HEARTBEAT_OK`) 不會傳遞。
-   如果隔離執行已透過訊息工具向同一目標發送訊息，則會跳過傳遞以避免重複。
-   缺少或無效的傳遞目標會導致工作排程失敗，除非 `delivery.bestEffort = true`。
-   只有當 `delivery.mode = "announce"` 時，才會將簡短摘要發佈到主要會話。
-   主要會話摘要會遵循 `wakeMode`：`now` 觸發立即心跳訊號，而
    `next-heartbeat` 等待下一次排定的心跳訊號。

### 模型和思維覆寫

隔離工作排程 (`agentTurn`) 可以覆寫模型和思維層級：

-   `model`：供應商/模型字串 (例如 `anthropic/claude-sonnet-4-20250514`) 或別名 (例如 `opus`)
-   `thinking`：思維層級 (`off`、`minimal`、`low`、`medium`、`high`、`xhigh`；僅限 GPT-5.2 + Codex 模型)

注意：您也可以在主要會話工作排程上設定 `model`，但它會變更共享的主要
會話模型。我們建議僅針對隔離工作排程使用模型覆寫，以避免
意外的情境轉換。

解析優先順序：

1.  工作排程酬載覆寫 (最高)
2.  Hook 特定預設值 (例如 `hooks.gmail.model`)
3.  代理程式設定預設值

### 傳遞 (通道 + 目標)

隔離工作排程可以透過頂層 `delivery` 設定將輸出傳遞到通道：

-   `delivery.mode`：`announce` (傳遞摘要) 或 `none`。
-   `delivery.channel`：`whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (外掛程式) / `signal` / `imessage` / `last`。
-   `delivery.to`：通道特定的收件人目標。

傳遞設定僅適用於隔離工作排程 (`sessionTarget: "isolated"`)。

如果 `delivery.channel` 或 `delivery.to` 被省略，cron 可以回退到主要會話的
「最後路由」(代理程式上次回覆的位置)。

目標格式提醒：

-   Slack/Discord/Mattermost (外掛程式) 目標應使用明確的前綴 (例如 `channel:<id>`、`user:<id>`) 以避免模糊不清。
-   Telegram 主題應使用 `:topic:` 形式 (請參閱下方)。

#### Telegram 傳遞目標 (主題 / 論壇討論串)

Telegram 透過 `message_thread_id` 支援論壇主題。對於 cron 傳遞，您可以將主題/討論串編碼到 `to` 欄位中：

-   `-1001234567890` (僅聊天 ID)
-   `-1001234567890:topic:123` (建議：明確的主題標記)
-   `-1001234567890:123` (縮寫：數字後綴)

也接受 `telegram:...` / `telegram:group:...` 等帶前綴的目標：

-   `telegram:group:-1001234567890:topic:123`

## 工具呼叫的 JSON 綱要

當直接呼叫 Gateway `cron.*` 工具 (代理程式工具呼叫或 RPC) 時，請使用這些格式。
CLI 標誌接受像 `20m` 這樣的人類可讀持續時間，但工具呼叫應使用 ISO 8601 字串
表示 `schedule.at` 和毫秒表示 `schedule.everyMs`。

### cron.add 參數

一次性、主要會話工作排程 (系統事件)：

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

帶有傳遞功能的重複隔離工作排程：

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

-   `schedule.kind`：`at` (`at`)、`every` (`everyMs`) 或 `cron` (`expr`，選填 `tz`)。
-   `schedule.at` 接受 ISO 8601 (時區選填；省略時視為 UTC)。
-   `everyMs` 是毫秒。
-   `sessionTarget` 必須是 `"main"` 或 `"isolated"`，並且必須與 `payload.kind` 匹配。
-   選填欄位：`agentId`、`description`、`enabled`、`deleteAfterRun` (對於 `at` 預設為 true)、
    `delivery`。
-   `wakeMode` 省略時預設為 `"now"`。

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

-   `jobId` 是規範的；為了相容性，也接受 `id`。
-   在修補程式中使用 `agentId: null` 以清除代理程式綁定。

### cron.run 和 cron.remove 參數

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 儲存與歷史記錄

-   工作排程儲存：`~/.openclaw/cron/jobs.json` (Gateway 管理的 JSON)。
-   執行歷史記錄：`~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL，自動修剪)。
-   覆寫儲存路徑：設定中的 `cron.store`。

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

完全停用 cron：

-   `cron.enabled: false` (設定)
-   `OPENCLAW_SKIP_CRON=1` (環境變數)

## CLI 快速入門

一次性提醒 (UTC ISO，成功後自動刪除)：

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

一次性提醒 (主要會話，立即喚醒)：

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

重複隔離工作排程 (公告到 WhatsApp)：

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

重複隔離工作排程 (傳遞到 Telegram 主題)：

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

帶有模型和思維覆寫的隔離工作排程：

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

代理程式選擇 (多代理程式設定)：

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手動執行 (force 為預設值，使用 `--due` 僅在到期時執行)：

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

編輯現有工作排程 (修補欄位)：

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

執行歷史記錄：

```bash
openclaw cron runs --id <jobId> --limit 50
```

不建立工作排程的立即系統事件：

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API 介面

-   `cron.list`、`cron.status`、`cron.add`、`cron.update`、`cron.remove`
-   `cron.run` (強制或到期時)、`cron.runs`
    對於不建立工作排程的立即系統事件，請使用[`openclaw system event`](/cli/system)。

## 疑難排解

### 「沒有任何東西執行」

-   檢查 cron 是否已啟用：`cron.enabled` 和 `OPENCLAW_SKIP_CRON`。
-   檢查 Gateway 是否持續執行 (cron 在 Gateway 處理程序內部執行)。
-   對於 `cron` 排程：確認時區 (`--tz`) 與主機時區的差異。

### 重複工作排程在失敗後不斷延遲

-   OpenClaw 在連續錯誤後對重複工作排程應用指數重試退避：
    30 秒、1 分鐘、5 分鐘、15 分鐘，然後是每次重試之間 60 分鐘。
-   退避會在下一次成功執行後自動重設。
-   一次性 (`at`) 工作排程在終端執行 (`ok`、`error` 或 `skipped`) 後會停用，並且不會重試。
```
