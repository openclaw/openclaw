---
summary: "CLI 參考 `openclaw cron` (排程並執行背景工作)"
read_when:
  - 您需要排程工作和喚醒
  - 您正在偵錯 cron 執行和日誌
title: "cron"
---

# `openclaw cron`

管理用於 Gateway 排程器的 cron 工作。

相關：

- Cron 工作: [Cron 工作](/automation/cron-jobs)

提示：執行 `openclaw cron --help` 以查看完整的指令介面。

注意：獨立的 `cron add` 工作預設為 `--announce` 傳遞。使用 `--no-deliver` 以保持輸出在內部。`--deliver` 仍作為 `--announce` 的已棄用別名。

注意：一次性 (`--at`) 工作預設在成功後刪除。使用 `--keep-after-run` 以保留它們。

注意：重複性工作現在在連續錯誤後使用指數退避重試 (30s → 1m → 5m → 15m → 60m)，然後在下次成功執行後恢復正常排程。

## 常見編輯

更新傳遞設定而不改變訊息：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

禁用針對獨立工作的傳遞：

```bash
openclaw cron edit <job-id> --no-deliver
```

發布到特定頻道：

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
