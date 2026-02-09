---
summary: "在自動化中選擇 heartbeat 與 cron 工作的指引"
read_when:
  - 決定如何排程重複性任務
  - 設定背景監控或通知
  - 為定期檢查最佳化權杖使用量
title: "Cron 與 Heartbeat"
---

# Cron 與 Heartbeat：何時使用各自的機制

Heartbeat 與 cron 工作都能讓你依排程執行任務。本指南協助你為你的使用情境選擇合適的機制。 This guide helps you choose the right mechanism for your use case.

## 快速決策指南

| 使用情境           | 建議             | 原因                                       |
| -------------- | -------------- | ---------------------------------------- |
| 每 30 分鐘檢查收件匣   | Heartbeat      | Batches with other checks, context-aware |
| 每天上午 9 點準時寄送報告 | Cron（隔離）       | 需要精準時間                                   |
| 監控行事曆的即將到來事件   | Heartbeat      | 天然適合週期性察覺                                |
| 每週執行深度分析       | Cron（隔離）       | 獨立任務，可使用不同模型                             |
| 20 分鐘後提醒我      | Cron（主，`--at`） | One-shot with precise timing             |
| 背景專案健康檢查       | Heartbeat      | Piggybacks on existing cycle             |

## Heartbeat：週期性察覺

Heartbeats run in the **main session** at a regular interval (default: 30 min). They're designed for the agent to check on things and surface anything important.

### 何時使用 heartbeat

- **多項週期性檢查**：與其使用 5 個獨立的 cron 工作分別檢查收件匣、行事曆、天氣、通知與專案狀態，不如用單一 heartbeat 將這些批次處理。
- **Context-aware decisions**: The agent has full main-session context, so it can make smart decisions about what's urgent vs. what can wait.
- **對話連續性**：Heartbeat 執行共用同一工作階段，代理程式能記住近期對話並自然跟進。
- **低負擔監控**：一個 heartbeat 取代多個小型輪詢任務。

### Heartbeat 的優點

- **批次多項檢查**：一次代理程式回合即可同時檢視收件匣、行事曆與通知。
- **降低 API 呼叫**：單一 heartbeat 比 5 個隔離的 cron 工作更省成本。
- **情境感知**：代理程式知道你正在做什麼，能相應地排序優先順序。
- **智慧抑制**：若沒有需要注意的事項，代理程式會回覆 `HEARTBEAT_OK`，且不會送出任何訊息。
- **自然時機**：會依佇列負載略有漂移，對多數監控來說是可接受的。

### Heartbeat 範例：HEARTBEAT.md 檢查清單

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

代理程式會在每次 heartbeat 讀取此檔，並在一次回合中處理所有項目。

### 設定 heartbeat

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

請參閱 [Heartbeat](/gateway/heartbeat) 以取得完整設定。

## Cron：精準排程

Cron 工作會在**精確時間**執行，且可在隔離的工作階段中運行，不影響主情境。

### 何時使用 cron

- **需要精準時機**：「每週一上午 9:00 準時寄送」（不是「大約 9 點左右」）。
- **獨立任務**：不需要對話情境的任務。
- **不同模型／思考**：需要更強模型的重度分析。
- **一次性提醒**：「20 分鐘後提醒我」，搭配 `--at`。
- **吵雜／高頻任務**：會讓主工作階段歷史雜亂的任務。
- **外部觸發**：應獨立於代理程式是否活躍而執行的任務。

### Cron 的優點

- **精準時機**：支援時區的 5 欄位 cron 表達式。
- **工作階段隔離**：在 `cron:<jobId>` 中執行，不會污染主歷史。
- **模型覆寫**：每個工作可使用更便宜或更強的模型。
- **投遞控制**：隔離工作預設為 `announce`（摘要）；可依需求選擇 `none`。
- **即時傳送**：公告模式會直接發佈，不需等待心跳。
- **不需要代理上下文**：即使主工作階段閒置或已壓縮也能執行。
- **一次性支援**：`--at` 用於精準的未來時間戳。

### Cron 範例：每日早晨簡報

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

此工作會在紐約時間上午 7:00 準時執行，使用 Opus 以確保品質，並直接向 WhatsApp 公告摘要。

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

請參閱 [Cron jobs](/automation/cron-jobs) 以取得完整的 CLI 參考。

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

## 結合兩者

最高效的設定同時使用**兩者**：

1. **Heartbeat**：每 30 分鐘以一次批次回合處理例行監控（收件匣、行事曆、通知）。
2. **Cron**：處理精準排程（每日報告、每週回顧）與一次性提醒。

### 範例：高效率自動化設定

**HEARTBEAT.md**（每 30 分鐘檢查）：

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron 工作**（精準時機）：

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster：具備核准的確定性工作流程

Lobster 是用於需要確定性執行與明確核准的 **多步驟工具管線** 的工作流程執行期。
當任務不只是一個代理回合，且你想要可恢復、包含人工檢查點的工作流程時使用它。

### Lobster 的適用情境

- **多步驟自動化**：需要固定的工具呼叫管線，而非一次性提示。
- **核准關卡**：有副作用的操作應在你核准前暫停，核准後再繼續。
- **可恢復執行**：在不重跑先前步驟的情況下繼續暫停的流程。

### 與 heartbeat 與 cron 的搭配方式

- **Heartbeat／cron** 決定「何時」執行。
- **Lobster** 定義開始後「要做哪些步驟」。

對於排程式工作流程，使用 cron 或 heartbeat 觸發一個代理程式回合以呼叫 Lobster。
對於臨時工作流程，直接呼叫 Lobster。
對於臨時工作流程，直接呼叫 Lobster。

### 營運備註（來自程式碼）

- Lobster 以**本機子程序**（`lobster` CLI）在工具模式中執行，並回傳 **JSON 封裝**。
- 若工具回傳 `needs_approval`，你可使用 `resumeToken` 與 `approve` 旗標繼續。
- 該工具是**選用外掛**；建議透過 `tools.alsoAllow: ["lobster"]` 以加法方式啟用。
- 若你傳入 `lobsterPath`，它必須是**絕對路徑**。

請參閱 [Lobster](/tools/lobster) 以取得完整用法與範例。

## 主工作階段 vs 隔離工作階段

Heartbeat 與 cron 都能與主工作階段互動，但方式不同：

|      | Heartbeat             | Cron（主）           | Cron（隔離）       |
| ---- | --------------------- | ----------------- | -------------- |
| 工作階段 | 主                     | 主（透過系統事件）         | `cron:<jobId>` |
| 歷史   | 共享                    | 共享                | 每次皆為全新         |
| 情境   | 完整                    | 完整                | 無（乾淨起始）        |
| 模型   | 主工作階段模型               | 主工作階段模型           | 可覆寫            |
| 輸出   | 若非 `HEARTBEAT_OK` 則投遞 | Heartbeat 提示 + 事件 | 公告摘要（預設）       |

### 何時使用主工作階段 cron

當你想要以下行為時，使用 `--session main` 搭配 `--system-event`：

- 提醒／事件出現在主工作階段情境中
- 代理程式在下一次 heartbeat 以完整情境處理
- 不需要獨立的隔離執行

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### 何時使用隔離 cron

當你想要以下行為時，使用 `--session isolated`：

- 不受先前情境影響的乾淨起點
- 不同的模型或思考設定
- 直接向頻道公告摘要
- 不會讓主工作階段雜亂的歷史記錄

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

| 機制        | 成本輪廓                                            |
| --------- | ----------------------------------------------- |
| Heartbeat | 每 N 分鐘一次回合；隨 HEARTBEAT.md 規模而成長 |
| Cron（主）   | 將事件加入下一次 heartbeat（無隔離回合）                       |
| Cron（隔離）  | 每個工作一次完整代理程式回合；可用較便宜模型                          |

**小技巧**：

- 保持 `HEARTBEAT.md` 精簡，以降低權杖負擔。
- 將相似檢查批次到 heartbeat，而非多個 cron 工作。
- 若只需要內部處理，在 heartbeat 上使用 `target: "none"`。
- 對例行任務使用隔離 cron 並搭配較便宜的模型。

## 相關

- [Heartbeat](/gateway/heartbeat)－完整的 heartbeat 設定
- [Cron jobs](/automation/cron-jobs)－完整的 cron CLI 與 API 參考
- [System](/cli/system)－系統事件與 heartbeat 控制
