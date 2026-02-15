---
summary: "自動化作業中 Heartbeat 與 Cron Jobs 的選擇指南"
read_when:
  - 決定如何排程重複性任務時
  - 設定背景監控或通知時
  - 最佳化定期檢查的 Token 使用量時
title: "Cron 與 Heartbeat 的比較"
---

# Cron 與 Heartbeat：何時使用

Heartbeat 和 Cron Jobs 都能讓您排程執行任務。本指南將協助您針對不同的使用情境選擇正確的機制。

## 快速決策指南

| 使用情境                             | 建議採用             | 原因                                     |
| ------------------------------------ | ------------------- | ---------------------------------------- |
| 每 30 分鐘檢查收件匣                 | Heartbeat           | 與其他檢查批次處理，具備情境感知能力     |
| 每天上午 9 點準時發送日報            | Cron (獨立工作階段) | 需要精確的計時                           |
| 監控行事曆中的即將發生事件           | Heartbeat           | 自然適合定期感知                         |
| 每週執行深度分析                     | Cron (獨立工作階段) | 獨立任務，可使用不同的模型               |
| 20 分鐘後提醒我                      | Cron (主工作階段, `--at`) | 一次性且精確的計時                     |
| 背景專案健康檢查                     | Heartbeat           | 附隨現有循環                             |

## Heartbeat：定期感知

Heartbeat 會在**主工作階段**中以固定間隔（預設：30 分鐘）執行。它們旨在讓智慧代理檢查事物並呈現任何重要資訊。

### 何時使用 Heartbeat

- **多個定期檢查**：一個 Heartbeat 可以批次處理所有這些檢查，而非 5 個獨立的 Cron Jobs 分別檢查收件匣、行事曆、天氣、通知和專案狀態。
- **具情境感知能力的決策**：智慧代理擁有完整的主工作階段情境，因此可以智慧地判斷什麼是緊急的，什麼可以等待。
- **對話連貫性**：Heartbeat 執行共享相同的工作階段，因此智慧代理會記住最近的對話，並可以自然地進行追蹤。
- **低開銷監控**：一個 Heartbeat 可以取代許多小型輪詢任務。

### Heartbeat 優勢

- **批次處理多個檢查**：智慧代理的一個回合可以同時檢閱收件匣、行事曆和通知。
- **減少 API 呼叫**：一個 Heartbeat 比 5 個獨立的 Cron Jobs 更具成本效益。
- **情境感知**：智慧代理知道您一直在處理什麼，並可以據此設定優先順序。
- **智慧抑制**：如果沒有什麼需要關注的，智慧代理會回覆 `HEARTBEAT_OK`，並且不會傳遞任何訊息。
- **自然計時**：根據佇列負載會略微漂移，這對於大多數監控來說都是可以接受的。

### Heartbeat 範例：HEARTBEAT.md 清單

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

智慧代理會在每個 Heartbeat 執行時讀取此檔案，並在一個回合中處理所有項目。

### 設定 Heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

有關完整設定，請參閱 [Heartbeat](/gateway/heartbeat)。

## Cron：精確排程

Cron Jobs 會在**精確時間**執行，並可以在獨立的工作階段中執行，而不影響主情境。

### 何時使用 Cron

- **需要精確計時**：「每個星期一上午 9:00 發送此訊息」（而不是「大約 9 點左右」）。
- **獨立任務**：不需要對話情境的任務。
- **不同的模型/思考能力**：需要更強大模型進行的繁重分析。
- **一次性提醒**：使用 `--at` 進行「20 分鐘後提醒我」。
- **嘈雜/頻繁任務**：會混淆主工作階段歷史記錄的任務。
- **外部觸發器**：應獨立於智慧代理是否活動而執行的任務。

### Cron 優勢

- **精確計時**：支援時區的 5 欄位 Cron 表示式。
- **工作階段隔離**：在 `cron:<jobId>` 中執行，不會污染主歷史記錄。
- **模型覆寫**：每個任務使用更經濟或更強大的模型。
- **傳遞控制**：獨立任務預設為 `announce`（摘要）；可根據需要選擇 `none`。
- **即時傳遞**：發布模式直接發布，無需等待 Heartbeat。
- **無需智慧代理情境**：即使主工作階段閒置或壓縮，也會執行。
- **一次性支援**：`--at` 用於精確的未來時間戳記。

### Cron 範例：每日早報

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

這會在紐約時間上午 7:00 準時執行，使用 Opus 來確保品質，並直接向 WhatsApp 發布摘要。

### Cron 範例：一次性提醒

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

有關完整的 CLI 參考，請參閱 [Cron Jobs](/automation/cron-jobs)。

## 決策流程圖

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## 兩者結合使用

最有效率的設定是**兩者結合使用**：

1.  **Heartbeat** 每 30 分鐘處理一次日常監控（收件匣、行事曆、通知），在一個批次回合中完成。
2.  **Cron** 處理精確排程（日報、週報）和一次性提醒。

### 範例：高效自動化設定

**HEARTBEAT.md** (每 30 分鐘檢查一次)：

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron Jobs** (精確計時)：

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster：帶有核准的確定性工作流程

Lobster 是用於需要確定性執行和明確核准的**多步驟工具管線**的工作流程運行時。
當任務超過智慧代理的一個回合，且您需要一個帶有人工檢查點的可恢復工作流程時，請使用它。

### 何時適用 Lobster

- **多步驟自動化**：您需要固定的工具呼叫管線，而不是一次性提示。
- **核准關卡**：副作用應暫停，直到您核准後再繼續。
- **可恢復執行**：繼續暫停的工作流程，而無需重新執行早期步驟。

### 它如何與 Heartbeat 和 Cron 搭配使用

- **Heartbeat/Cron** 決定執行_何時_發生。
- **Lobster** 定義執行開始後_會發生哪些步驟_。

對於排程的工作流程，使用 cron 或 heartbeat 觸發呼叫 Lobster 的智慧代理回合。
對於臨時工作流程，直接呼叫 Lobster。

### 操作注意事項（來自程式碼）

- Lobster 在工具模式下作為**本地子程序** (`lobster` CLI) 執行，並返回 **JSON 封包**。
- 如果工具返回 `needs_approval`，您可以透過 `resumeToken` 和 `approve` 旗標繼續執行。
- 該工具是**可選外掛程式**；透過 `tools.alsoAllow: ["lobster"]` 附加啟用（建議）。
- 如果您傳遞 `lobsterPath`，它必須是**絕對路徑**。

有關完整的使用方式和範例，請參閱 [Lobster](/tools/lobster)。

## 主工作階段與獨立工作階段

Heartbeat 和 Cron 都可以與主工作階段互動，但方式不同：

|         | Heartbeat                       | Cron (主工作階段)       | Cron (獨立工作階段)      |
| ------- | ------------------------------- | ------------------------ | -------------------------- |
| 工作階段 | 主工作階段                       | 主工作階段 (透過系統事件) | `cron:<jobId>`             |
| 歷史記錄 | 共享                            | 共享                     | 每次執行皆為全新           |
| 情境    | 完整                            | 完整                     | 無 (全新開始)              |
| 模型    | 主工作階段模型                  | 主工作階段模型           | 可覆寫                     |
| 輸出    | 若非 `HEARTBEAT_OK` 則傳遞        | Heartbeat 提示 + 事件    | 發布摘要 (預設)            |

### 何時使用主工作階段 Cron

當您希望達到以下目的時，請將 `--session main` 與 `--system-event` 搭配使用：

- 提醒/事件出現在主工作階段情境中
- 智慧代理在下一個 Heartbeat 執行時以完整情境處理它
- 沒有單獨的獨立執行

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### 何時使用獨立工作階段 Cron

當您希望達到以下目的時，請使用 `--session isolated`：

- 沒有先前情境的全新開始
- 不同的模型或思考設定
- 直接向頻道發布摘要
- 不會混淆主工作階段的歷史記錄

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## 成本考量

| 機制             | 成本概況                                            |
| --------------- | ------------------------------------------------------- |
| Heartbeat       | 每 N 分鐘一個回合；隨 HEARTBEAT.md 大小擴展            |
| Cron (主工作階段) | 將事件新增至下一個 Heartbeat（無獨立回合）               |
| Cron (獨立工作階段) | 每個任務一個完整的智慧代理回合；可使用更經濟的模型      |

**提示**：

- 保持 `HEARTBEAT.md` 檔案較小，以最大程度減少 Token 開銷。
- 將類似的檢查批次處理到 Heartbeat 中，而非多個 Cron Jobs。
- 如果您只需要內部處理，請在 Heartbeat 上使用 `target: "none"`。
- 對於日常任務，使用帶有更經濟模型的獨立工作階段 Cron。

## 相關資訊

- [Heartbeat](/gateway/heartbeat) - 完整的 Heartbeat 設定
- [Cron Jobs](/automation/cron-jobs) - 完整的 Cron CLI 和 API 參考
- [System](/cli/system) - 系統事件 + Heartbeat 控制
