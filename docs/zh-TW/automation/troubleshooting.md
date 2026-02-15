---
summary: "疑難排解 cron 和 heartbeat 的排程與傳送"
read_when:
  - Cron 未執行
  - Cron 已執行但未傳送訊息
  - Heartbeat 似乎無聲或已跳過
title: "自動化疑難排解"
---

# 自動化疑難排解

使用此頁面解決排程器和傳送問題 (cron + heartbeat)。

## 指令階梯

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後執行自動化檢查：

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron 未觸發

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

良好的輸出應如下所示：

- `cron status` 報告已啟用且有未來的 `nextWakeAtMs`。
- 工作已啟用且具有有效的排程/時區。
- `cron runs` 顯示 `ok` 或明確的跳過原因。

常見的特徵：

- `cron: scheduler disabled; jobs will not run automatically` → cron 在設定/環境中已停用。
- `cron: timer tick failed` → 排程器計時器發生錯誤；檢查周圍的堆疊/日誌上下文。
- `reason: not-due` 在執行輸出中 → 手動執行未帶 `--force` 且工作尚未到期。

## Cron 已觸發但未傳送

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

良好的輸出應如下所示：

- 執行狀態為 `ok`。
- 傳送模式/目標已為獨立工作設定。
- 頻道探測報告目標頻道已連線。

常見的特徵：

- 執行成功但傳送模式為 `none` → 不預期有外部訊息。
- 傳送目標遺失/無效 (`channel`/`to`) → 執行可能在內部成功但跳過出站。
- 頻道憑證錯誤 (`unauthorized`, `missing_scope`, `Forbidden`) → 傳送因頻道憑證/權限而被阻擋。

## Heartbeat 已抑制或跳過

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

良好的輸出應如下所示：

- Heartbeat 已啟用且間隔非零。
- 最後一次 heartbeat 結果為 `ran` (或跳過原因已理解)。

常見的特徵：

- `heartbeat skipped` with `reason=quiet-hours` → 超出 `activeHours`。
- `requests-in-flight` → 主線忙碌；heartbeat 已延遲。
- `empty-heartbeat-file` → `HEARTBEAT.md` 存在但沒有可執行的內容。
- `alerts-disabled` → 可見性設定抑制出站 heartbeat 訊息。

## 時區和 activeHours 的陷阱

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

快速規則：

- `Config path not found: agents.defaults.userTimezone` 表示該鍵未設定；heartbeat 會回退到主機時區 (如果 `activeHours.timezone` 已設定，則使用該設定)。
- 不帶 `--tz` 的 Cron 使用 Gateway 主機時區。
- Heartbeat `activeHours` 使用已設定的時區解析度 (`user`, `local`, 或明確的 IANA tz)。
- 不帶時區的 ISO 時間戳記在 cron `at` 排程中視為 UTC。

常見的特徵：

- 主機時區變更後，工作在錯誤的實際時間執行。
- 由於 `activeHours.timezone` 不正確，Heartbeat 在您的白天總是跳過。

相關：

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
