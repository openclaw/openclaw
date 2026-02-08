---
read_when:
  - 你想在不创建 cron 作业的情况下入队系统事件
  - 你需要启用或禁用心跳
  - 你想检查系统在线状态条目
summary: "`openclaw system` 的 CLI 参考（系统事件、心跳、在线状态）"
title: system
x-i18n:
  generated_at: "2026-02-03T07:45:23Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 36ae5dbdec327f5a32f7ef44bdc1f161bad69868de62f5071bb4d25a71bfdfe9
  source_path: cli/system.md
  workflow: 15
---

# `openclaw system`

Gateway 网关的系统级辅助工具：入队系统事件、控制心跳和查看在线状态。

## 常用命令

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

在**主**会话上入队系统事件。下一次心跳会将其作为 `System:` 行注入到提示中。使用 `--mode now` 立即触发心跳；`next-heartbeat` 等待下一个计划的心跳时刻。

标志：

- `--text <text>`：必填的系统事件文本。
- `--mode <mode>`：`now` 或 `next-heartbeat`（默认）。
- `--json`：机器可读输出。

## `system heartbeat last|enable|disable`

心跳控制：

- `last`：显示最后一次心跳事件。
- `enable`：重新开启心跳（如果之前被禁用，使用此命令）。
- `disable`：暂停心跳。

标志：

- `--json`：机器可读输出。

## `system presence`

列出 Gateway 网关已知的当前系统在线状态条目（节点、实例和类似状态行）。

标志：

- `--json`：机器可读输出。

## 注意

- 需要一个运行中的 Gateway 网关，可通过你当前的配置访问（本地或远程）。
- 系统事件是临时的，不会在重启后持久化。
