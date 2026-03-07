---
read_when:
  - 你需要定时作业和唤醒功能
  - 你正在调试 cron 执行和日志
summary: "`openclaw cron` 的 CLI 参考（调度和运行后台作业）"
title: cron
x-i18n:
  generated_at: "2026-02-03T07:44:47Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bc9317c824f3b6339df657cc269961d9b5f121da65ec2b23a07d454e6d611135
  source_path: cli/cron.md
  workflow: 15
---

# `openclaw cron`

管理 Gateway 网关调度器的 cron 作业。

相关内容：

- Cron 作业：[Cron 作业](/automation/cron-jobs)

提示：运行 `openclaw cron --help` 查看完整的命令集。

说明：隔离式 `cron add` 任务默认使用 `--announce` 投递摘要。使用 `--no-deliver` 仅内部运行。
`--deliver` 仍作为 `--announce` 的弃用别名保留。

说明：一次性（`--at`）任务成功后默认删除。使用 `--keep-after-run` 保留。

## 常见编辑

更新投递设置而不更改消息：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

为隔离的作业禁用投递：

```bash
openclaw cron edit <job-id> --no-deliver
```
