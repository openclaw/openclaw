---
read_when:
  - 你想查找某个渠道的联系人/群组/自身 ID
  - 你正在开发渠道目录适配器
summary: "`openclaw directory` 的 CLI 参考（self、peers、groups）"
title: directory
x-i18n:
  generated_at: "2026-02-01T19:58:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 7c878d9013aeaa22c8a21563fac30b465a86be85d8c917c5d4591b5c3d4b2025
  source_path: cli/directory.md
  workflow: 14
---

# `openclaw directory`

对支持目录功能的渠道进行查找（联系人/对等方、群组和"我"）。

## 通用参数

- `--channel <name>`：渠道 ID/别名（配置了多个渠道时为必填；仅配置一个渠道时自动选择）
- `--account <id>`：账号 ID（默认：渠道默认账号）
- `--json`：输出 JSON 格式

## 说明

- `directory` 用于帮助你查找可粘贴到其他命令中的 ID（特别是 `openclaw message send --target ...`）。
- 对于许多渠道，结果来源于配置（允许列表/已配置的群组），而非实时的提供商目录。
- 默认输出为以制表符分隔的 `id`（有时包含 `name`）；脚本中请使用 `--json`。

## 将结果用于 `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 格式（按渠道）

- WhatsApp：`+15551234567`（私聊），`1234567890-1234567890@g.us`（群组）
- Telegram：`@username` 或数字聊天 ID；群组为数字 ID
- Slack：`user:U…` 和 `channel:C…`
- Discord：`user:<id>` 和 `channel:<id>`
- Matrix（插件）：`user:@user:server`、`room:!roomId:server` 或 `#alias:server`
- Microsoft Teams（插件）：`user:<id>` 和 `conversation:<id>`
- Zalo（插件）：用户 ID（Bot API）
- Zalo Personal / `zalouser`（插件）：来自 `zca` 的会话 ID（私聊/群组）（`me`、`friend list`、`group list`）

## Self（"我"）

```bash
openclaw directory self --channel zalouser
```

## Peers（联系人/用户）

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## 群组

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
