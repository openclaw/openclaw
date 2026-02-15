---
summary: "openclaw cron CLI 參考文件 (排程與執行背景任務)"
read_when:
  - 您需要排程任務與喚醒
  - 您正在對 cron 執行與記錄進行除錯
title: "cron"
---

# `openclaw cron`

管理 Gateway 排程器的 cron 任務。

相關內容：

- Cron 任務：[Cron 任務](/automation/cron-jobs)

提示：執行 `openclaw cron --help` 查看完整的指令介面。

注意：獨立的 `cron add` 任務預設為 `--announce` 傳遞。使用 `--no-deliver` 來保留內部輸出。`--deliver` 仍作為 `--announce` 的棄用別名保留。

注意：一次性 (`--at`) 任務預設在成功後刪除。使用 `--keep-after-run` 來保留它們。

注意：定期任務現在在連續錯誤後會使用指數級重試退避 (30s → 1m → 5m → 15m → 60m)，並在下一次成功執行後恢復正常排程。

## 常見編輯操作

在不更改訊息的情況下更新傳遞設定：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

停用獨立任務的傳遞：

```bash
openclaw cron edit <job-id> --no-deliver
```

發布到特定頻道：

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
