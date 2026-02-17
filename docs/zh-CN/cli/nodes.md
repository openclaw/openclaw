---
read_when:
  - 你正在管理已配对的节点（摄像头、屏幕、画布）
  - 你需要批准请求或调用节点命令
summary: "`openclaw nodes` 的 CLI 参考（列表/状态/批准/调用，摄像头/画布/屏幕）"
title: nodes
x-i18n:
  generated_at: "2026-02-03T10:04:26Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 23da6efdd659a82dbbc4afd18eb4ab1020a2892f69c28d610f912c8a799f734c
  source_path: cli/nodes.md
  workflow: 15
---

# `openclaw nodes`

管理已配对的节点（设备）并调用节点功能。

相关内容：

- 节点概述：[节点](/nodes)
- 摄像头：[摄像头节点](/nodes/camera)
- 图像：[图像节点](/nodes/images)

通用选项：

- `--url`、`--token`、`--timeout`、`--json`

## 常用命令

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` 打印待处理/已配对表格。已配对行包含最近连接时长（Last Connect）。
使用 `--connected` 仅显示当前已连接的节点。使用 `--last-connected <duration>`
筛选在指定时间段内连接过的节点（例如 `24h`、`7d`）。

## 调用 / 运行

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

调用标志：

- `--params <json>`：JSON 对象字符串（默认 `{}`）。
- `--invoke-timeout <ms>`：节点调用超时（默认 `15000`）。
- `--idempotency-key <key>`：可选的幂等键。

### Exec 风格默认值

`nodes run` 与模型的 exec 行为一致（默认值 + 审批）：

- 读取 `tools.exec.*`（以及 `agents.list[].tools.exec.*` 覆盖）。
- 在调用 `system.run` 前使用 exec 审批（`exec.approval.request`）。
- 当设置了 `tools.exec.node` 时可省略 `--node`。
- 需要支持 `system.run` 的节点（macOS 配套应用或无头节点主机）。

标志：

- `--cwd <path>`：工作目录。
- `--env <key=val>`：环境变量覆盖（可重复）。
- `--command-timeout <ms>`：命令超时。
- `--invoke-timeout <ms>`：节点调用超时（默认 `30000`）。
- `--needs-screen-recording`：要求屏幕录制权限。
- `--raw <command>`：运行 shell 字符串（`/bin/sh -lc` 或 `cmd.exe /c`）。
- `--agent <id>`：智能体范围的审批/白名单（默认为已配置的智能体）。
- `--ask <off|on-miss|always>`、`--security <deny|allowlist|full>`：覆盖选项。
