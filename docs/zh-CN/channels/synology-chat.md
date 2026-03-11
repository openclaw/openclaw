**摘要：** Synology Chat webhook 配置与 OpenClaw 配置指南

**阅读时机：**

- 配置 Synology Chat 与 OpenClaw 的集成
- 排查 Synology Chat webhook 路由问题

---

# Synology Chat（插件）

**状态：** 通过插件支持，作为使用 Synology Chat webhooks 的私信通道。

该插件接收来自 Synology Chat 外向 webhooks 的入站消息，并通过 Synology Chat 内向 webhooks 发送回复。

## 需要安装插件

Synology Chat 基于插件实现，不属于默认核心通道安装。

从本地检出安装：

```bash
openclaw plugins install ./extensions/synology-chat
```

详细说明：[插件](/tools/plugin)

## 快速配置

1. 安装并启用 Synology Chat 插件。
2. 在 Synology Chat 集成中：
   - 创建一个内向 webhook 并复制其 URL。
   - 创建一个带有你的密钥令牌的外向 webhook。
3. 将外向 webhook URL 指向你的 OpenClaw 网关：
   - 默认地址为 `https://gateway-host/webhook/synology`。
   - 或使用你自定义的 `channels.synology-chat.webhookPath`。
4. 在 OpenClaw 中配置 `channels.synology-chat`。
5. 重启网关，并向 Synology Chat 机器人发送一条私信。

最小配置示例：

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

对于默认账户，可以使用环境变量：

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS`（逗号分隔）
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

配置值会覆盖环境变量。

## 私信策略与访问控制

- `dmPolicy: "allowlist"` 是推荐的默认配置。
- `allowedUserIds` 接受 Synology 用户 ID 列表（逗号分隔的字符串也可以）。
- 在 `allowlist` 模式下，如果 `allowedUserIds` 列表为空，将被视为配置错误，webhook 路由不会启动（如果需要允许所有人，请使用 `dmPolicy: "open"`）。
- `dmPolicy: "open"` 允许任何发送者。
- `dmPolicy: "disabled"` 阻止私信。
- 配对审批功能支持以下命令：
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## 出站消息发送

使用数字形式的 Synology Chat 用户 ID 作为发送目标。

示例：

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

媒体文件发送支持基于 URL 的文件传输。

## 多账户支持

支持在 `channels.synology-chat.accounts` 下配置多个 Synology Chat 账户。每个账户可以覆盖令牌、内向 URL、webhook 路径、私信策略和限制。

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

## 安全注意事项

- 妥善保管 `token` 密钥，若泄露请及时轮换。
- 除非你明确信任自签名的本地 NAS 证书，否则请保持 `allowInsecureSsl: false`。
- 入站 webhook 请求会验证令牌并按发送者进行速率限制。
- 生产环境建议使用 `dmPolicy: "allowlist"`。

---
