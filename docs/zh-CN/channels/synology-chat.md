---
summary: "Synology Chat webhook 设置和 OpenClaw 配置"
read_when:
  - 设置 Synology Chat 与 OpenClaw
  - 调试 Synology Chat webhook 路由
title: "Synology Chat"
---

# Synology Chat (插件)

状态：通过插件支持，作为使用 Synology Chat webhooks 的直接消息频道。

## 需要插件

```bash
openclaw plugins install ./extensions/synology-chat
```

## 快速设置

1. 安装并启用 Synology Chat 插件
2. 在 Synology Chat 集成中：
   - 创建 incoming webhook 并复制其 URL
   - 创建 outgoing webhook 并设置你的 secret token
3. 将 outgoing webhook URL 指向你的 OpenClaw 网关
4. 在 OpenClaw 中配置 `channels.synology-chat`
5. 重启网关并向 Synology Chat 机器人发送 DM

最小配置：

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
    },
  },
}
```

## 环境变量

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_ALLOWED_USER_IDS`

## DM 策略

- `dmPolicy: "allowlist"` - 推荐默认
- `dmPolicy: "open"` - 允许任何发送者
- `dmPolicy: "disabled"` - 阻止 DM

## 发送消息

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello"
```
