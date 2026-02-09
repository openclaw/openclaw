---
summary: "`openclaw cron` 的 CLI 參考（排程並執行背景工作）"
read_when:
  - 你需要排程工作與喚醒
  - 你正在除錯 cron 的執行與記錄
title: "cron"
---

# `openclaw cron`

管理 Gateway 閘道器 排程器的 cron 工作。

Related:

- Cron 工作：[Cron jobs](/automation/cron-jobs)

提示：執行 `openclaw cron --help` 以查看完整的指令範圍。

注意：隔離的 `cron add` 工作預設會使用 `--announce` 傳遞。使用 `--no-deliver` 以將
輸出保留在內部。`--deliver` 仍保留為 `--announce` 的已淘汰別名。 Use `--no-deliver` to keep
output internal. `--deliver` remains as a deprecated alias for `--announce`.

注意：一次性（`--at`）工作在成功後預設會刪除。使用 `--keep-after-run` 以保留它們。 Use `--keep-after-run` to keep them.

注意：循環工作現在在連續錯誤後會使用指數型重試退避（30s → 1m → 5m → 15m → 60m），然後在下一次成功執行後回到正常排程。

## Common edits

在不變更訊息的情況下更新傳遞設定：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

為隔離的工作停用傳遞：

```bash
openclaw cron edit <job-id> --no-deliver
```

公告到特定頻道：

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
