---
summary: CLI reference for `openclaw cron` (schedule and run background jobs)
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
title: cron
---

# `openclaw cron`

管理 Gateway 調度器的 cron 工作。

[[BLOCK_1]]

- 定時任務: [定時任務](/automation/cron-jobs)

提示：執行 `openclaw cron --help` 以獲取完整的命令介面。

注意：孤立的 `cron add` 工作預設為 `--announce` 傳遞。使用 `--no-deliver` 以保持輸出為內部。 `--deliver` 仍然是 `--announce` 的已棄用別名。

注意：一次性 (`--at`) 工作在成功後會預設刪除。使用 `--keep-after-run` 來保留它們。

注意：定期任務現在在連續錯誤後使用指數回退重試（30秒 → 1分鐘 → 5分鐘 → 15分鐘 → 60分鐘），然後在下一次成功執行後恢復正常排程。

注意：`openclaw cron run` 現在在手動執行排隊後會立即返回。成功的回應包括 `{ ok: true, enqueued: true, runId }`；使用 `openclaw cron runs --id <job-id>` 來跟蹤最終結果。

注意：保留/修剪在設定中控制：

- `cron.sessionRetention` (預設 `24h`) 剪除已完成的孤立執行會話。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` 剪除 `~/.openclaw/cron/runs/<jobId>.jsonl`。

升級注意事項：如果您有舊的 cron 工作，請在當前的交付/存儲格式之前執行 `openclaw doctor --fix`。Doctor 現在會對舊版 cron 欄位 (`jobId`, `schedule.cron`，頂層交付欄位，payload `provider` 交付別名) 進行標準化，並在設定 `cron.webhook` 時將簡單的 `notify: true` webhook 備援工作遷移到明確的 webhook 交付。

## Common edits

更新交付設定而不更改訊息：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

禁用孤立工作的交付：

```bash
openclaw cron edit <job-id> --no-deliver
```

啟用輕量級啟動上下文以進行獨立作業：

```bash
openclaw cron edit <job-id> --light-context
```

[[BLOCK_1]]  
公告至特定頻道：  
[[INLINE_1]]

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

建立一個具有輕量級啟動上下文的獨立工作：

```bash
openclaw cron add \
  --name "Lightweight morning brief" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize overnight updates." \
  --light-context \
  --no-deliver
```

`--light-context` 僅適用於孤立的代理人回合工作。對於定時任務，輕量模式會保持啟動上下文為空，而不是注入完整的工作區啟動集。
