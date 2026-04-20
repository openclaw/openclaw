---
summary: "`openclaw directory`的CLI参考（自己、对等方、组）"
read_when:
  - 您想查找通道的联系人/组/自己的ID
  - 您正在开发通道目录适配器
title: "directory"
---

# `openclaw directory`

支持它的通道的目录查找（联系人/对等方、组和"我"）。

## 常用标志

- `--channel <name>`: 通道ID/别名（当配置了多个通道时需要；当只配置了一个通道时自动）
- `--account <id>`: 账户ID（默认：通道默认）
- `--json`: 输出JSON

## 注意事项

- `directory`旨在帮助您找到可以粘贴到其他命令中的ID（特别是`openclaw message send --target ...`）。
- 对于许多通道，结果是配置支持的（允许列表/配置的组），而不是实时提供者目录。
- 默认输出是`id`（有时是`name`），用制表符分隔；使用`--json`进行脚本编写。

## 将结果与`message send`一起使用

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID格式（按通道）

- WhatsApp: `+15551234567`（DM），`1234567890-1234567890@g.us`（组）
- Telegram: `@username`或数字聊天ID；组是数字ID
- Slack: `user:U…`和`channel:C…`
- Discord: `user:<id>`和`channel:<id>`
- Matrix（插件）: `user:@user:server`，`room:!roomId:server`，或`#alias:server`
- Microsoft Teams（插件）: `user:<id>`和`conversation:<id>`
- Zalo（插件）: 用户ID（Bot API）
- Zalo Personal / `zalouser`（插件）: 来自`zca`的线程ID（DM/组）（`me`，`friend list`，`group list`）

## 自己（"me"）

```bash
openclaw directory self --channel zalouser
```

## 对等方（联系人/用户）

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## 组

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
