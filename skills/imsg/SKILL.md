---
name: imsg
description: iMessage/SMS CLI for listing chats, history, and sending messages via Messages.app.
homepage: https://imsg.to
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "os": ["darwin"],
        "requires": { "bins": ["imsg"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/imsg",
              "bins": ["imsg"],
              "label": "Install imsg (brew)",
            },
          ],
      },
  }
---

# imsg

使用 `imsg` 通过 macOS Messages.app 读取和发送 iMessage/SMS。

## 何时使用

✅ **使用此 skill 当：**

- 用户明确要求发送 iMessage 或 SMS
- 读取 iMessage 对话历史
- 检查最近的 Messages.app 聊天
- 发送到电话号码或 Apple ID

## 何时不使用

❌ **不要使用此 skill 当：**

- Telegram 消息 → 使用 `message` 工具和 `channel:telegram`
- Signal 消息 → 使用已配置的 Signal 频道
- WhatsApp 消息 → 使用已配置的 WhatsApp 频道
- Discord 消息 → 使用 `message` 工具和 `channel:discord`
- Slack 消息 → 使用 `slack` skill
- 群组聊天管理（添加/移除成员）→ 不支持
- 批量/群发消息 → 始终先确认用户
- 在当前对话中回复 → 正常回复即可（OpenClaw 自动路由）

## 要求

- 已登录 Messages.app 的 macOS
- 终端的完全磁盘访问权限
- Messages.app 的自动化权限（用于发送）

## 常用命令

### 列出聊天

```bash
imsg chats --limit 10 --json
```

### 查看历史

```bash
# 通过聊天 ID
imsg history --chat-id 1 --limit 20 --json

# 带附件信息
imsg history --chat-id 1 --limit 20 --attachments --json
```

### 监视新消息

```bash
imsg watch --chat-id 1 --attachments
```

### 发送消息

```bash
# 仅文本
imsg send --to "+14155551212" --text "Hello!"

# 带附件
imsg send --to "+14155551212" --text "Check this out" --file /path/to/image.jpg

# 指定服务
imsg send --to "+14155551212" --text "Hi" --service imessage
imsg send --to "+14155551212" --text "Hi" --service sms
```

## 服务选项

- `--service imessage` — 强制 iMessage（需要收件人有 iMessage）
- `--service sms` — 强制 SMS（绿色气泡）
- `--service auto` — 让 Messages.app 决定（默认）

## 安全规则

1. **发送前始终确认收件人和消息内容**
2. **未经用户明确批准，永远不要发送到未知号码**
3. **小心附件** — 确认文件路径存在
4. **限制自己** — 不要垃圾邮件

## 示例工作流程

用户："Text mom that I'll be late"

```bash
# 1. 找到妈妈的聊天
imsg chats --limit 20 --json | jq '.[] | select(.displayName | contains("Mom"))'

# 2. 确认用户
# "Found Mom at +1555123456. Send 'I'll be late' via iMessage?"

# 3. 确认后发送
imsg send --to "+1555123456" --text "I'll be late"
```
