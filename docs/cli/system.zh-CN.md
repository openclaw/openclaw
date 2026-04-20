---
summary: "`openclaw system` 命令行参考（系统事件、心跳、存在）"
read_when:
  - 你想在不创建 cron 作业的情况下入队系统事件
  - 你需要启用或禁用心跳
  - 你想检查系统存在条目
title: "system"
---

# `openclaw system`

网关的系统级助手：入队系统事件、控制心跳和查看存在。

所有 `system` 子命令使用网关 RPC 并接受共享客户端标志：

- `--url <url>`
- `--token <token>`
- `--timeout <ms>`
- `--expect-final`

## 常见命令

```bash
openclaw system event --text "检查紧急跟进事项" --mode now
openclaw system event --text "检查紧急跟进事项" --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

在**主**会话上入队系统事件。下一次心跳会将其作为 `System:` 行注入到提示中。使用 `--mode now` 立即触发心跳；`next-heartbeat` 等待下一个计划的 tick。

标志：

- `--text <text>`：必需的系统事件文本。
- `--mode <mode>`：`now` 或 `next-heartbeat`（默认）。
- `--json`：机器可读输出。
- `--url`、`--token`、`--timeout`、`--expect-final`：共享网关 RPC 标志。

## `system heartbeat last|enable|disable`

心跳控制：

- `last`：显示最后一次心跳事件。
- `enable`：重新开启心跳（如果它们被禁用）。
- `disable`：暂停心跳。

标志：

- `--json`：机器可读输出。
- `--url`、`--token`、`--timeout`、`--expect-final`：共享网关 RPC 标志。

## `system presence`

列出网关知道的当前系统存在条目（节点、实例和类似状态行）。

标志：

- `--json`：机器可读输出。
- `--url`、`--token`、`--timeout`、`--expect-final`：共享网关 RPC 标志。

## 注意

- 需要一个可通过当前配置（本地或远程）访问的运行中的网关。
- 系统事件是临时的，不会在重启后持久化。