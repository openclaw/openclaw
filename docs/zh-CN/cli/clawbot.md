---
summary: "`openclaw clawbot` CLI 参考（遗留别名命名空间）"
read_when:
  - 你维护使用 `openclaw clawbot ...` 的旧脚本
  - 你需要迁移到当前命令的指导
title: "clawbot"
---

# `openclaw clawbot`

保留用于向后兼容的遗留别名命名空间。

当前支持的别名：

- `openclaw clawbot qr`（与 [`openclaw qr`](/cli/qr) 行为相同）

## 迁移

建议直接使用现代顶级命令：

- `openclaw clawbot qr` -> `openclaw qr`
