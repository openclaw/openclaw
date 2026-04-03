---
read_when:
  - 你正在管理已配对节点（相机、屏幕、画布）
  - 你需要批准请求或调用节点命令
summary: "`openclaw nodes` 的 CLI 参考（列表/状态/批准/调用、相机/画布/屏幕）"
title: 节点
x-i18n:
  generated_at: "2026-03-29T23:52:03Z"
  model: gpt-5.4
  provider: openai
  source_hash: 91d16fba3c12c0cce5e585a7f5072a831de3e10928b2c34bdbf126b3b718e0c3
  source_path: cli/nodes.md
  workflow: 15
---

# `openclaw nodes`

管理已配对节点（设备）并调用节点能力。

相关内容：

- 节点概览：[节点](/nodes)
- 相机：[相机节点](/nodes/camera)
- 图像：[图像节点](/nodes/images)

常用选项：

- `--url`, `--token`, `--timeout`, `--json`

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

`nodes list` 会打印待处理/已配对表格。已配对行包含距离最近一次连接的时间（上次连接）。
使用 `--connected` 仅显示当前已连接的节点。使用 `--last-connected <duration>` 将
结果筛选为在某个时长内连接过的节点（例如 `24h`、`7d`）。

## 调用

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
```

调用标志：

- `--params <json>`：JSON 对象字符串（默认 `{}`）。
- `--invoke-timeout <ms>`：节点调用超时时间（默认 `15000`）。
- `--idempotency-key <key>`：可选的幂等键。
- 此处不允许使用 `system.run` 和 `system.run.prepare`；如需在命令行中执行命令，请使用带 `host=node` 的 `exec` 工具。

要在节点上以命令行方式执行命令，请使用带 `host=node` 的 `exec` 工具，而不是 `openclaw nodes run`。
`nodes` CLI 现在以能力为中心：通过 `nodes invoke` 直接进行远程过程调用，以及配对、相机、
屏幕、位置、画布和通知。
