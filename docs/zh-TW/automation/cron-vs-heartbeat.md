---
summary: Guidance for choosing between heartbeat and cron jobs for automation
read_when:
  - Deciding how to schedule recurring tasks
  - Setting up background monitoring or notifications
  - Optimizing token usage for periodic checks
title: Cron vs Heartbeat
---

# Cron 與 Heartbeat：何時使用各自的功能

心跳和定時任務都可以讓你按照計劃執行任務。本指南將幫助你選擇適合你使用情境的正確機制。

## 快速決策指南

| 使用案例                  | 推薦方式            | 原因                             |
| ------------------------- | ------------------- | -------------------------------- |
| 每 30 分鐘檢查收件匣      | Heartbeat           | 與其他檢查批次處理，具上下文意識 |
| 每天上午 9 點準時發送報告 | Cron (獨立)         | 需要精確的時間                   |
| 監控日曆中的即將到來事件  | Heartbeat           | 自然適合定期的意識               |
| 每週進行深入分析          | Cron (獨立)         | 獨立任務，可以使用不同的模型     |
| 20 分鐘後提醒我           | Cron (主要, `--at`) | 一次性任務，需精確的時間         |
| 背景專案健康檢查          | Heartbeat           | 利用現有的循環                   |

## Heartbeat: 定期意識

心跳在 **主要會話** 中以固定的時間間隔執行（預設：30 分鐘）。它們的設計是讓代理檢查狀況並顯示任何重要的事項。

### 何時使用心跳（heartbeat）

- **多重定期檢查**：不需要五個獨立的 cron 工作來檢查收件箱、日曆、天氣、通知和專案狀態，而是可以用一個心跳來批次處理這些。
- **情境感知決策**：代理擁有完整的主會話上下文，因此可以聰明地判斷什麼是緊急的，什麼可以等。
- **對話連貫性**：心跳執行共享相同的會話，因此代理能夠記住最近的對話並自然地進行後續跟進。
- **低開銷監控**：一個心跳取代了許多小型輪詢任務。

### Heartbeat 優勢

- **批次處理多個檢查**：一個代理回合可以同時檢查收件箱、日曆和通知。
- **減少 API 呼叫**：單一的心跳比五個獨立的排程工作便宜。
- **上下文感知**：代理知道你正在處理的內容，並可以相應地優先排序。
- **智能抑制**：如果沒有任何需要注意的事項，代理會回覆 `HEARTBEAT_OK`，且不會發送任何訊息。
- **自然時機**：根據佇列負載稍微漂移，這對於大多數監控來說是可以接受的。

### 心跳範例：HEARTBEAT.md 檢查清單

# Heartbeat 檢查清單

- 檢查電子郵件以尋找緊急訊息
- 檢視日曆以查看接下來 2 小時的活動
- 如果背景任務完成，總結結果
- 如果閒置超過 8 小時，發送簡短的檢查訊息

代理在每次心跳時讀取這個並在一次循環中處理所有專案。

### 設定心跳設定

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // explicit alert delivery target (default is "none")
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

請參閱 [Heartbeat](/gateway/heartbeat) 以獲取完整的設定資訊。

## Cron: 精確排程

Cron 工作在精確的時間執行，並且可以在獨立的會話中執行，而不會影響主要上下文。每小時的定期排程會透過每個工作在 0-5 分鐘範圍內的確定性偏移自動分散。

### 何時使用 cron

- **精確的時間要求**： "每週一上午9:00發送這個"（而不是 "大約9點"）。
- **獨立任務**：不需要對話上下文的任務。
- **不同的模型/思維**：需要更強大模型的深入分析。
- **一次性提醒**： "20分鐘後提醒我" 連同 `--at`。
- **嘈雜/頻繁的任務**：會使主要會話歷史變得雜亂的任務。
- **外部觸發**：應該獨立於代理是否活躍而執行的任務。

### Cron 的優點

1. **自動化任務**：Cron 可以自動執行定期任務，減少手動操作的需要，提升工作效率。

2. **靈活的排程**：使用者可以根據需求設定任務的執行時間，支援分鐘、時、日、月和星期的靈活設定。

3. **資源管理**：Cron 可以在系統負載較低的時候執行任務，幫助更有效地管理系統資源。

4. **簡單易用**：Cron 的語法相對簡單，使用者可以輕鬆編寫和修改排程任務。

5. **廣泛的應用**：許多系統和應用程式都支援 Cron，這使得它成為一個通用的解決方案。

6. **日誌記錄**：Cron 可以記錄任務的執行狀態，方便使用者進行監控和故障排除。

- **精確計時**：支援時區的 5 欄位或 6 欄位（秒）cron 表達式。
- **內建負載分散**：每小時的重複排程預設會錯開最多 5 分鐘。
- **每個任務控制**：可使用 `--stagger <duration>` 來覆蓋錯開，或使用 `--exact` 強制精確計時。
- **會話隔離**：在 `cron:<jobId>` 中執行，不會污染主歷史紀錄。
- **模型覆蓋**：每個任務可使用更便宜或更強大的模型。
- **交付控制**：隔離的任務預設為 `announce`（摘要）；根據需要選擇 `none`。
- **即時交付**：公告模式直接發佈，無需等待心跳。
- **不需要代理上下文**：即使主會話閒置或被壓縮也能執行。
- **一次性支援**：`--at` 用於精確的未來時間戳。

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

這個程式會在紐約時間早上 7:00 準時執行，使用 Opus 來確保品質，並直接向 WhatsApp 發佈摘要。

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

請參閱 [Cron jobs](/automation/cron-jobs) 以獲取完整的 CLI 參考。

## 決策流程圖

任務是否需要在確切的時間執行？
是 -> 使用 cron
否 -> 繼續...

這個任務需要與主會話隔離嗎？
是 -> 使用 cron（隔離）
否 -> 繼續...

這項任務可以與其他定期檢查一起批次處理嗎？
是 -> 使用心跳（新增至 HEARTBEAT.md）
否 -> 使用 cron

這是一個一次性提醒嗎？
是 -> 使用 cron 搭配 --at
否 -> 繼續...

是否需要不同的模型或思考層級？
是 -> 使用 cron（獨立）搭配 --model/--thinking
否 -> 使用 heartbeat

## 結合兩者

最有效的設置使用 **兩者**：

1. **Heartbeat** 每 30 分鐘進行一次批次處理，負責例行監控（收件箱、日曆、通知）。
2. **Cron** 負責精確的排程（每日報告、每週回顧）和一次性提醒。

### 範例：高效的自動化設置

**HEARTBEAT.md**（每 30 分鐘檢查一次）：

# Heartbeat 檢查清單

- 掃描收件匣以尋找緊急郵件
- 檢查日曆以查看接下來 2 小時的活動
- 檢視任何待處理的任務
- 如果 8 小時以上安靜，輕度檢查進度

**Cron 工作**（精確計時）：

# 每日早上 7 點的簡報

openclaw cron add --name "早上簡報" --cron "0 7 \* \* \*" --session isolated --message "..." --announce

# 每週專案回顧於星期一上午9點

openclaw cron add --name "每週回顧" --cron "0 9 \* \* 1" --session isolated --message "..." --model opus

# 一次性提醒

openclaw cron add --name "回撥" --at "2h" --session main --system-event "回撥客戶" --wake now

## Lobster: 確定性工作流程與批准

Lobster 是用於 **多步驟工具管道** 的工作流程執行環境，適用於需要確定性執行和明確批准的情況。當任務超過單一代理的回合，並且您希望擁有可恢復的工作流程以及人為檢查點時，請使用它。

### Lobster 何時適用

- **多步驟自動化**：您需要一個固定的工具調用流程，而不是一次性的提示。
- **批准閘道**：副作用應該暫停，直到您批准後再繼續。
- **可恢復的執行**：在不重新執行早期步驟的情況下，繼續暫停的工作流程。

### 它如何與 heartbeat 和 cron 配對

- **Heartbeat/cron** 決定 _何時_ 執行執行。
- **Lobster** 定義 _執行開始後_ 會發生 _哪些步驟_。

對於排程工作流程，使用 cron 或 heartbeat 來觸發一個代理回合，該回合會呼叫 Lobster。對於即時工作流程，直接呼叫 Lobster。

### 操作說明（來自程式碼）

- Lobster 以 **本地子程序** (`lobster` CLI) 的方式執行於工具模式，並返回 **JSON 信封**。
- 如果工具返回 `needs_approval`，您可以繼續使用 `resumeToken` 和 `approve` 標誌。
- 該工具是一個 **可選插件**；建議透過 `tools.alsoAllow: ["lobster"]` 以附加方式啟用。
- Lobster 期望 `lobster` CLI 在 `PATH` 上可用。

請參閱 [Lobster](/tools/lobster) 以獲取完整的使用說明和範例。

## 主會話與隔離會話

heartbeat 和 cron 都可以與主會話互動，但方式不同：

|         | 心跳                           | Cron（主要）         | Cron（獨立）     |
| ------- | ------------------------------ | -------------------- | ---------------- |
| Session | 主要                           | 主要（透過系統事件） | `cron:<jobId>`   |
| History | 共享                           | 共享                 | 每次執行時全新   |
| Context | 完整                           | 完整                 | 無（全新開始）   |
| Model   | 主要會話模型                   | 主要會話模型         | 可以覆蓋         |
| Output  | 如果不是 `HEARTBEAT_OK` 則交付 | 心跳提示 + 事件      | 宣告摘要（預設） |

### 何時使用主要會話排程器 (main session cron)

當你想要時，使用 `--session main` 與 `--system-event`：

- 提醒/事件將出現在主要會話上下文中
- 代理將在下一次心跳中以完整上下文處理它
- 不會有單獨的孤立執行

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### 何時使用獨立的 cron

獨立的 cron 任務適合在以下情況下使用：

1. **資源需求高**：當任務需要大量資源時，將其獨立執行可以避免影響其他任務的性能。
2. **執行時間長**：如果任務的執行時間不確定，獨立的 cron 可以確保不會干擾到其他定時任務。
3. **錯誤隔離**：獨立的 cron 任務可以在發生錯誤時不影響整體系統，便於排錯和維護。
4. **特定環境需求**：當任務需要特定的環境變數或設定時，獨立的 cron 可以提供所需的環境設定。
5. **不同的執行頻率**：如果某些任務需要與其他任務不同的執行頻率，獨立的 cron 可以靈活調整。

在這些情況下，使用獨立的 cron 可以提高系統的穩定性和可維護性。

當你想要時，請使用 `--session isolated`：

- 一個沒有先前上下文的全新開始
- 不同的模型或思考設定
- 直接向頻道公告摘要
- 不會干擾主要會話的歷史紀錄

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

| 機制        | 成本概況                                            |
| ----------- | --------------------------------------------------- |
| 心跳        | 每 N 分鐘進行一次循環；隨著 HEARTBEAT.md 大小而增長 |
| Cron (主要) | 將事件添加到下一次心跳（無獨立循環）                |
| Cron (獨立) | 每個任務進行完整的代理循環；可以使用較便宜的模型    |

**提示**:

- 保持 `HEARTBEAT.md` 小以最小化 token 開銷。
- 將相似的檢查批次處理到 heartbeat 中，而不是多個 cron 工作。
- 如果只想進行內部處理，請在 heartbeat 上使用 `target: "none"`。
- 對於例行任務，使用獨立的 cron 和較便宜的模型。

## 相關內容

- [Heartbeat](/gateway/heartbeat) - 完整的心跳設定
- [Cron jobs](/automation/cron-jobs) - 完整的 cron CLI 和 API 參考
- [System](/cli/system) - 系統事件 + 心跳控制
