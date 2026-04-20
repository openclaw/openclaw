---
summary: "`openclaw pairing` 命令行参考（批准/列出配对请求）"
read_when:
  - 你正在使用配对模式 DM 并需要批准发送者
title: "pairing"
---

# `openclaw pairing`

批准或检查 DM 配对请求（适用于支持配对的频道）。

相关：

- 配对流程：[配对](/channels/pairing)

## 命令

```bash
openclaw pairing list telegram
openclaw pairing list --channel telegram --account work
openclaw pairing list telegram --json

openclaw pairing approve <code>
openclaw pairing approve telegram <code>
openclaw pairing approve --channel telegram --account work <code> --notify
```

## `pairing list`

列出一个频道的待处理配对请求。

选项：

- `[channel]`: 位置频道 ID
- `--channel <channel>`: 显式频道 ID
- `--account <accountId>`: 多账户频道的账户 ID
- `--json`: 机器可读输出

注意：

- 如果配置了多个支持配对的频道，你必须通过位置或使用 `--channel` 提供频道。
- 只要频道 ID 有效，扩展频道就被允许。

## `pairing approve`

批准待处理的配对代码并允许该发送者。

使用方法：

- `openclaw pairing approve <channel> <code>`
- `openclaw pairing approve --channel <channel> <code>`
- 当只配置了一个支持配对的频道时，`openclaw pairing approve <code>`

选项：

- `--channel <channel>`: 显式频道 ID
- `--account <accountId>`: 多账户频道的账户 ID
- `--notify`: 在同一频道上向请求者发送确认

## 注意

- 频道输入：通过位置传递（`pairing list telegram`）或使用 `--channel <channel>`。
- `pairing list` 支持多账户频道的 `--account <accountId>`。
- `pairing approve` 支持 `--account <accountId>` 和 `--notify`。
- 如果只配置了一个支持配对的频道，则允许 `pairing approve <code>`。