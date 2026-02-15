---
summary: "疑難排解 cron 與 heartbeat 的排程與傳送"
read_when:
  - Cron 沒有執行
  - Cron 已執行但訊息未傳送
  - Heartbeat 似乎無聲無息或被跳過
title: "Automation 疑難排解"
---

# Automation 疑難排解

本頁面用於處理排程與傳送問題（`cron` + `heartbeat`）。

## 指令階梯

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

接著執行 automation 檢查：

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

正常的輸出如下：

- `cron status` 報告為已啟用且有未來的 `nextWakeAtMs`。
- 工作已啟用且具有有效的排程／時區。
- `cron runs` 顯示 `ok` 或明確的跳過原因。

常見特徵：

- `cron: scheduler disabled; jobs will not run automatically` → 在設定／環境變數中已禁用 cron。
- `cron: timer tick failed` → 排程器計時器（timer tick）執行失敗；請檢查周邊的堆疊（stack）／紀錄檔內容。
- 執行輸出中的 `reason: not-due` → 在尚未到達執行時間且未使用 `--force` 的情況下呼叫手動執行。

## Cron 已觸發但未傳送

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

正常的輸出如下：

- 執行狀態為 `ok`。
- 獨立工作已設定傳送模式／目標。
- 頻道探測報告目標頻道已連接。

常見特徵：

- 執行成功但傳送模式為 `none` → 預期不會發送外部訊息。
- 遺失或無效的傳送目標（`channel`/`to`）→ 執行可能在內部成功，但跳過外發傳送。
- 頻道認證錯誤（`unauthorized`、`missing_scope`、`Forbidden`）→ 傳送被頻道憑證／權限封鎖。

## Heartbeat 被抑制或跳過

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

正常的輸出如下：

- Heartbeat 已啟用且間隔（interval）非零。
- 最近一次 heartbeat 結果為 `ran`（或跳過原因已確認）。

常見特徵：

- `heartbeat skipped` 且 `reason=quiet-hours` → 處於 `activeHours` 之外。
- `requests-in-flight` → 主通道繁忙；heartbeat 已推遲。
- `empty-heartbeat-file` → `HEARTBEAT.md` 檔案存在但沒有可執行的內容。
- `alerts-disabled` → 可見度設定抑制了外發的 heartbeat 訊息。

## 時區與 activeHours 注意事項

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

快速規則：

- `Config path not found: agents.defaults.userTimezone` 表示該鍵名未設定；heartbeat 將回退至主機時區（若有設定則使用 `activeHours.timezone`）。
- 未使用 `--tz` 的 Cron 會使用 Gateway 主機時區。
- Heartbeat `activeHours` 使用設定的時區解析方式（`user`、`local` 或明確的 IANA 時區）。
- 對於 cron 的 `at` 排程，不含時區的 ISO 時間戳記會被視為 UTC。

常見特徵：

- 主機時區變更後，工作在錯誤的掛鐘時間執行。
- 由於 `activeHours.timezone` 錯誤，導致 heartbeat 在您的白天時間總是被跳過。

相關連結：

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
