---
summary: "選擇自動化任務的心跳 (Heartbeat) 或 Cron 排程建議"
read_when:
  - 決定如何安排循環任務
  - 設定背景監控或通知
  - 優化定期檢查的 Token 使用量
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat：何時使用何者

Heartbeat 與 Cron 任務都能讓你在排程上執行任務。本指南將協助你為使用案例選擇合適的機制。

## 快速決策指南

| 使用案例                  | 建議方式              | 原因                                   |
| ------------------------- | --------------------- | -------------------------------------- |
| 每 30 分鐘檢查一次收件夾  | Heartbeat             | 可與其他檢查合併處理，具備情境感知能力 |
| 每天早上 9 點準時發送報告 | Cron (獨立)           | 需要精確的定時                         |
| 監控日曆中的近期活動      | Heartbeat             | 自然適合定期感知                       |
| 執行每週深度分析          | Cron (獨立)           | 獨立任務，可使用不同的模型             |
| 20 分鐘後提醒我           | Cron (主階段, `--at`) | 具備精確定時的一次性任務               |
| 背景專案健康檢查          | Heartbeat             | 順帶利用現有的週期                     |

## Heartbeat：定期感知

Heartbeat 在 **主階段 (main session)** 以固定間隔執行（預設：30 分鐘）。其設計目的是讓代理人檢查各項事務並呈現任何重要內容。

### 何時使用 Heartbeat

- **多項定期檢查**：不需要設定 5 個獨立的 Cron 任務來檢查收件夾、日曆、天氣、通知和專案狀態，單一 Heartbeat 即可批次處理所有項目。
- **具備情境感知的決策**：代理人擁有完整的主階段上下文，因此可以針對哪些事項緊急、哪些可以稍後處理做出聰明的決策。
- **對話連續性**：Heartbeat 執行時共享相同的階段，因此代理人會記得近期的對話並能自然地進行後續追蹤。
- **低開銷監控**：一個 Heartbeat 即可取代許多小型輪詢任務。

### Heartbeat 優點

- **批次處理多項檢查**：一次代理人輪次即可同時檢視收件夾、日曆和通知。
- **減少 API 呼叫**：單一 Heartbeat 比 5 個獨立的 Cron 任務更省錢。
- **具備情境感知**：代理人知道你一直在處理什麼，並能據此排列優先順序。
- **智慧抑制**：如果沒有需要注意的事項，代理人會回覆 `HEARTBEAT_OK` 且不會傳送任何訊息。
- **自然時機**：會根據隊列負載產生輕微偏移，這對於大多數監控任務來說是可以接受的。

### Heartbeat 範例：HEARTBEAT.md 檢查清單

```md
# Heartbeat 檢查清單

- 檢查電子郵件是否有緊急訊息
- 檢視未來 2 小時內的日曆活動
- 如果背景任務已完成，摘要其結果
- 如果閒置超過 8 小時，發送簡短的問候
```

代理人在每次 Heartbeat 時都會讀取此檔案，並在一個輪次中處理所有項目。

### 設定 Heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 間隔
        target: "last", // 警示發送位置
        activeHours: { start: "08:00", end: "22:00" }, // 選填
      },
    },
  },
}
```

請參閱 [Heartbeat](/gateway/heartbeat) 瞭解完整設定。

## Cron：精確排程

Cron 任務在 **精確時間** 執行，且可以在獨立階段執行而不影響主上下文。

### 何時使用 Cron

- **需要精確定時**：「每週一早上 9:00 發送此訊息」（而非「9 點左右」）。
- **獨立任務**：不需要對話情境的任務。
- **不同模型/思考能力**：需要更強大模型進行繁重分析的任務。
- **一次性提醒**：使用 `--at` 進行「20 分鐘後提醒我」。
- **嘈雜/頻繁的任務**：會使主階段歷史紀錄變得雜亂的任務。
- **外部觸發**：應獨立於代理人是否活躍而執行的任務。

### Cron 優點

- **精確定時**：支援時區的 5 欄式 Cron 表達式。
- **階段隔離**：在 `cron:<jobId>` 中執行，不會污染主歷史紀錄。
- **模型覆寫**：可為每個任務使用更便宜或更強大的模型。
- **傳送控制**：獨立任務預設為 `announce`（摘要）；可根據需要選擇 `none`。
- **立即傳送**：公告模式會直接發布，無需等待 Heartbeat。
- **無需代理人情境**：即使主階段閒置或已壓縮也能執行。
- **一次性支援**：`--at` 支援精確的未來時間戳記。

### Cron 範例：每日早晨簡報

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "產生今日簡報：天氣、日曆、重要郵件、新聞摘要。" \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

此任務會在紐約時間早上 7:00 準時執行，使用 Opus 以確保品質，並直接向 WhatsApp 發布摘要。

### Cron 範例：一次性提醒

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "提醒：每日站立會議將在 10 分鐘後開始。" \
  --wake now \
  --delete-after-run
```

請參閱 [Cron jobs](/automation/cron-jobs) 瞭解完整 CLI 參考。

## 決策流程圖

```
任務是否需要在精確的時間執行？
  是 -> 使用 Cron
  否 -> 繼續...

任務是否需要與主階段隔離？
  是 -> 使用 Cron (獨立)
  否 -> 繼續...

此任務是否可以與其他定期檢查合併處理？
  是 -> 使用 Heartbeat (加入 HEARTBEAT.md)
  否 -> 使用 Cron

這是一個一次性提醒嗎？
  是 -> 使用帶有 --at 的 Cron
  否 -> 繼續...

是否需要不同的模型或思考層級？
  是 -> 使用帶有 --model/--thinking 的 Cron (獨立)
  否 -> 使用 Heartbeat
```

## 結合兩者

最有效的設定是 **同時使用** 兩者：

1. **Heartbeat** 每 30 分鐘以批次輪次處理例行監控（收件夾、日曆、通知）。
2. **Cron** 處理精確排程（每日報告、每週回顧）和一次性提醒。

### 範例：高效自動化設定

**HEARTBEAT.md**（每 30 分鐘檢查一次）：

```md
# Heartbeat 檢查清單

- 掃描收件夾是否有緊急郵件
- 檢查未來 2 小時內的日曆活動
- 審核任何待辦任務
- 如果安靜超過 8 小時，進行簡單問候
```

**Cron 任務**（精確定時）：

```bash
# 早上 7 點的每日早晨簡報
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# 每週一早上 9 點的每週專案回顧
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# 一次性提醒
openclaw cron add --name "Call back" --at "2h" --session main --system-event "回電給客戶" --wake now
```

## Lobster：具確定性的審核工作流

Lobster 是用於 **多步驟工具管線** 的工作流執行環境，需要確定性執行與明確的審核。
當任務不只是單次代理人輪次，且你希望擁有具備人為檢查點的可恢復工作流時，請使用它。

### Lobster 的適用時機

- **多步驟自動化**：你需要固定的工具呼叫管線，而非一次性提示。
- **審核閘道**：副作用應暫停直到你核准後再繼續。
- **可恢復執行**：繼續執行已暫停的工作流，而無需重新執行先前的步驟。

### 如何與 Heartbeat 及 Cron 搭配

- **Heartbeat/Cron** 決定執行 _何時_ 發生。
- **Lobster** 定義執行開始後發生 _哪些步驟_。

對於排程工作流，使用 Cron 或 Heartbeat 來觸發呼叫 Lobster 的代理人輪次。
對於臨機工作流，請直接呼叫 Lobster。

### 操作備註（源自程式碼）

- Lobster 以 **區域子程序** (`lobster` CLI) 模式在工具模式下執行，並回傳 **JSON 封套**。
- 如果工具回傳 `needs_approval`，你需使用 `resumeToken` 和 `approve` 標記來恢復。
- 此工具為 **選填外掛程式**；建議透過 `tools.alsoAllow: ["lobster"]` 累加啟用。
- 如果傳遞 `lobsterPath`，必須是 **絕對路徑**。

請參閱 [Lobster](/tools/lobster) 瞭解完整用法與範例。

## 主階段 vs 獨立階段

Heartbeat 與 Cron 都能與主階段互動，但方式不同：

|          | Heartbeat                  | Cron (主階段)         | Cron (獨立)      |
| -------- | -------------------------- | --------------------- | ---------------- |
| 階段     | 主階段 (Main)              | 主階段 (經由系統事件) | `cron:<jobId>`   |
| 歷史紀錄 | 共享                       | 共享                  | 每次執行皆為全新 |
| 上下文   | 完整                       | 完整                  | 無 (從零開始)    |
| 模型     | 主階段模型                 | 主階段模型            | 可覆寫           |
| 輸出     | 若非 `HEARTBEAT_OK` 則傳送 | Heartbeat 提示 + 事件 | 公告摘要 (預設)  |

### 何時使用主階段 Cron

當你希望達成以下目標時，請使用 `--session main` 搭配 `--system-event`：

- 提醒/事件出現在主階段上下文中
- 代理人在下一次 Heartbeat 時結合完整上下文處理它
- 無需獨立的隔離執行

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "該進行專案健康檢查了" \
  --wake now
```

### 何時使用獨立 Cron

當你希望達成以下目標時，請使用 `--session isolated`：

- 沒有先前上下文的乾淨狀態
- 不同的模型或思考設定
- 直接將公告摘要發布到通道
- 不會使主階段雜亂的歷史紀錄

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "每週程式碼庫分析..." \
  --model opus \
  --thinking high \
  --announce
```

## 成本考量

| 機制          | 成本設定                                         |
| ------------- | ------------------------------------------------ |
| Heartbeat     | 每 N 分鐘一個輪次；隨 HEARTBEAT.md 大小縮放      |
| Cron (主階段) | 將事件加入下一次 Heartbeat (無獨立輪次)          |
| Cron (獨立)   | 每個任務一個完整的代理人輪次；可使用較便宜的模型 |

**提示**：

- 保持 `HEARTBEAT.md` 簡短以最小化 Token 開銷。
- 將相似的檢查合併至 Heartbeat，而非使用多個 Cron 任務。
- 如果你只需要內部處理，請在 Heartbeat 上使用 `target: "none"`。
- 對於例行任務，使用較便宜模型的獨立 Cron。

## 相關連結

- [Heartbeat](/gateway/heartbeat) - 完整 Heartbeat 設定
- [Cron jobs](/automation/cron-jobs) - 完整 Cron CLI 與 API 參考
- [System](/cli/system) - 系統事件 + Heartbeat 控制
