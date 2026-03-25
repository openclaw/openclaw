---
read_when:
  - 设置 OpenClaw 与 Synology Chat
  - 调试 Synology Chat webhook 路由
summary: Synology Chat webhook 设置与 OpenClaw 配置
title: Synology Chat
x-i18n:
  generated_at: "2026-03-16T06:20:51Z"
  model: gpt-5.4
  provider: openai
  source_hash: 7d77598ea759f89873a1edf0a3a7e7fedc1e4a7067709aaca6b999056a89eb1a
  source_path: channels/synology-chat.md
  workflow: 15
---

# Synology Chat（插件）

状态：通过插件支持，作为使用 Synology Chat webhook 的私信渠道。
该插件接受来自 Synology Chat 出站 webhook 的入站消息，并通过 Synology Chat 入站 webhook 发送回复。

## 需要插件

Synology Chat 基于插件，不属于默认的核心渠道安装内容。

从本地检出安装：

```bash
openclaw plugins install ./extensions/synology-chat
```

详情：[插件](/tools/plugin)

## 快速设置

1. 安装并启用 Synology Chat 插件。
   - `openclaw onboard` 现在会在与 `openclaw channels add` 相同的渠道设置列表中显示 Synology Chat。
   - 非交互式设置：`openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. 在 Synology Chat 集成中：
   - 创建一个入站 webhook 并复制其 URL。
   - 使用你的 secret token 创建一个出站 webhook。
3. 将出站 webhook URL 指向你的 OpenClaw Gateway 网关：
   - 默认是 `https://gateway-host/webhook/synology`。
   - 或者使用你自定义的 `channels.synology-chat.webhookPath`。
4. 在 OpenClaw 中完成设置。
   - 引导式：`openclaw onboard`
   - 直接设置：`openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. 重启 Gateway 网关，并向 Synology Chat 机器人发送一条私信。

最小配置：

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## 环境变量

对于默认账户，你可以使用环境变量：

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS`（逗号分隔）
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

配置值会覆盖环境变量。

## 私信策略与访问控制

- 推荐的默认值是 `dmPolicy: "allowlist"`。
- `allowedUserIds` 接受 Synology 用户 ID 列表（或逗号分隔字符串）。
- 在 `allowlist` 模式下，空的 `allowedUserIds` 列表会被视为配置错误，webhook 路由将不会启动（如需允许所有人，请使用 `dmPolicy: "open"`）。
- `dmPolicy: "open"` 允许任何发送方。
- `dmPolicy: "disabled"` 会阻止私信。
- 配对批准可配合以下命令使用：
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## 出站投递

使用数字形式的 Synology Chat 用户 ID 作为目标。

示例：

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

支持通过基于 URL 的文件投递发送媒体。

## 多账户

支持在 `channels.synology-chat.accounts` 下配置多个 Synology Chat 账户。
每个账户都可以覆盖 token、入站 URL、webhook 路径、私信策略和限制。

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## 安全说明

- 妥善保管 `token`，如果泄露请轮换。
- 除非你明确可信任本地 NAS 的自签名证书，否则请保持 `allowInsecureSsl: false`。
- 入站 webhook 请求会按 token 验证，并按发送方进行速率限制。
- 生产环境优先使用 `dmPolicy: "allowlist"`。
