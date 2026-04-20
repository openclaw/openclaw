---
summary: "`openclaw nodes` 命令行参考（状态、配对、调用、相机/画布/屏幕）"
read_when:
  - 你正在管理配对节点（相机、屏幕、画布）
  - 你需要批准请求或调用节点命令
title: "nodes"
---

# `openclaw nodes`

管理配对节点（设备）并调用节点功能。

相关：

- 节点概述：[节点](/nodes)
- 相机：[相机节点](/nodes/camera)
- 图像：[图像节点](/nodes/images)

通用选项：

- `--url`、`--token`、`--timeout`、`--json`

## 通用命令

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes rename --node <id|name|ip> --name <displayName>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` 打印待处理/配对表格。配对行包括最近的连接年龄（最后连接）。
使用 `--connected` 只显示当前连接的节点。使用 `--last-connected <duration>` 来
过滤在一段时间内连接的节点（例如 `24h`、`7d`）。

批准说明：

- `openclaw nodes pending` 只需要配对范围。
- `openclaw nodes approve <requestId>` 从待处理请求继承额外的范围要求：
  - 无命令请求：仅配对
  - 非执行节点命令：配对 + 写入
  - `system.run` / `system.run.prepare` / `system.which`：配对 + 管理员

## 调用

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
```

调用标志：

- `--params <json>`: JSON 对象字符串（默认 `{}`）。
- `--invoke-timeout <ms>`: 节点调用超时（默认 `15000`）。
- `--idempotency-key <key>`: 可选的幂等键。
- `system.run` 和 `system.run.prepare` 在此处被阻止；使用带有 `host=node` 的 `exec` 工具进行 shell 执行。

要在节点上执行 shell，请使用带有 `host=node` 的 `exec` 工具，而不是 `openclaw nodes run`。
`nodes` CLI 现在以功能为中心：通过 `nodes invoke` 进行直接 RPC，以及配对、相机、
屏幕、位置、画布和通知。
