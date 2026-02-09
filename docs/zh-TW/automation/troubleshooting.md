---
summary: "疑難排解 cron 與 heartbeat 的排程與傳送問題"
read_when:
  - Cron 未執行
  - Cron 已執行但未傳送任何訊息
  - Heartbeat 似乎無聲或被略過
title: "自動化疑難排解"
---

# 自動化疑難排解

當遇到排程器與傳送問題時，請使用此頁面（`cron` + `heartbeat`）。

## 指令階梯

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

接著執行自動化檢查：

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

良好的輸出看起來會是：

- `cron status` 顯示為已啟用，且有未來的 `nextWakeAtMs`。
- 工作已啟用，且具有有效的排程／時區。
- `cron runs` 顯示 `ok` 或明確的略過原因。

Common signatures:

- `cron: scheduler disabled; jobs will not run automatically` → cron 在設定／環境變數中被停用。
- `cron: timer tick failed` → 排程器 tick 當掉；請檢查周邊的堆疊／日誌內容。
- 在執行輸出中出現 `reason: not-due` → 手動執行時未帶 `--force`，且工作尚未到期。

## Cron 已觸發但未傳送

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

良好的輸出看起來會是：

- Run status is `ok`.
- 隔離的工作已設定傳送模式／目標。
- 頻道探測回報目標頻道已連線。

Common signatures:

- 執行成功但傳送模式為 `none` → 預期不會有對外訊息。
- 傳送目標遺失／無效（`channel`/`to`）→ 內部執行可能成功，但會略過對外傳送。
- 頻道驗證錯誤（`unauthorized`、`missing_scope`、`Forbidden`）→ 傳送因頻道憑證／權限而被阻擋。

## Heartbeat 被抑制或略過

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

良好的輸出看起來會是：

- Heartbeat 已啟用，且間隔為非零。
- 最近一次 heartbeat 結果為 `ran`（或略過原因已明確）。

Common signatures:

- `heartbeat skipped` 搭配 `reason=quiet-hours` → 超出 `activeHours`。
- `requests-in-flight` → 主車道忙碌；heartbeat 被延後。
- `empty-heartbeat-file` → `HEARTBEAT.md` 存在，但沒有可執行的內容。
- `alerts-disabled` → 可見性設定抑制了對外的 heartbeat 訊息。

## Timezone 與 activeHours 的陷阱

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

快速規則：

- `Config path not found: agents.defaults.userTimezone` 表示該金鑰未設定；heartbeat 會回退至主機時區（或若有設定則使用 `activeHours.timezone`）。
- 未指定 `--tz` 的 cron 會使用 Gateway 閘道器主機的時區。
- Heartbeat 的 `activeHours` 會使用已設定的時區解析（`user`、`local`，或明確的 IANA 時區）。
- 未含時區的 ISO 時間戳，對於 cron 的 `at` 排程會視為 UTC。

Common signatures:

- Jobs run at the wrong wall-clock time after host timezone changes.
- Heartbeat 在你的白天時段總是被略過，因為 `activeHours.timezone` 設定錯誤。

Related:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
