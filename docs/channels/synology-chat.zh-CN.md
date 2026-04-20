---
summary: "Synology Chat webhook 设置和 OpenClaw 配置"
read_when:
  - 设置 Synology Chat 与 OpenClaw 集成
  - 调试 Synology Chat webhook 路由
title: "Synology Chat"
---

# Synology Chat

状态：使用 Synology Chat webhook 的捆绑插件直接消息通道。
该插件接受来自 Synology Chat 出站 webhook 的入站消息，并通过 Synology Chat 入站 webhook 发送回复。

## 捆绑插件

Synology Chat 在当前 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是旧版本或不包含 Synology Chat 的自定义安装，可以手动安装：

从本地检出安装：

```bash
openclaw plugins install ./path/to/local/synology-chat-plugin
```

详情：[插件](/tools/plugin)

## 快速设置

1. 确保 Synology Chat 插件可用：
   - 当前打包的 OpenClaw 版本已经捆绑了它
   - 旧版本/自定义安装可以通过上述命令从源码检出手动添加
   - `openclaw onboard` 现在在与 `openclaw channels add` 相同的通道设置列表中显示 Synology Chat
   - 非交互式设置：`openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. 在 Synology Chat 集成中：
   - 创建一个入站 webhook 并复制其 URL
   - 创建一个带有您的密钥令牌的出站 webhook
3. 将出站 webhook URL 指向您的 OpenClaw 网关：
   - 默认情况下为 `https://gateway-host/webhook/synology`
   - 或您自定义的 `channels.synology-chat.webhookPath`
4. 在 OpenClaw 中完成设置：
   - 引导式：`openclaw onboard`
   - 直接：`openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. 重启网关并向 Synology Chat 机器人发送直接消息

Webhook 认证详情：

- OpenClaw 接受来自 `body.token` 的出站 webhook 令牌，然后是 `?token=...`，最后是标头
- 接受的标头形式：
  - `x-synology-token`
  - `x-webhook-token`
  - `x-openclaw-token`
  - `Authorization: Bearer <token>`
- 空或缺失的令牌将失败关闭

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

对于默认账户，您可以使用环境变量：

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS`（逗号分隔）
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

配置值覆盖环境变量。

## 直接消息策略和访问控制

- `dmPolicy: "allowlist"` 是推荐的默认设置
- `allowedUserIds` 接受 Synology 用户 ID 的列表（或逗号分隔的字符串）
- 在 `allowlist` 模式下，空的 `allowedUserIds` 列表被视为配置错误，webhook 路由将不会启动（使用 `dmPolicy: "open"` 允许所有人）
- `dmPolicy: "open"` 允许任何发送者
- `dmPolicy: "disabled"` 阻止直接消息
- 回复接收者绑定默认保持在稳定的数字 `user_id` 上。`channels.synology-chat.dangerouslyAllowNameMatching: true` 是一种紧急兼容模式，重新启用可变用户名/昵称查找以进行回复传递
- 配对批准可通过以下命令工作：
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## 出站传递

使用数字 Synology Chat 用户 ID 作为目标。

示例：

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

媒体发送通过基于 URL 的文件传递支持。

## 多账户

在 `channels.synology-chat.accounts` 下支持多个 Synology Chat 账户。
每个账户可以覆盖令牌、入站 URL、webhook 路径、DM 策略和限制。
直接消息会话按账户和用户隔离，因此两个不同 Synology 账户上的相同数字 `user_id` 不会共享转录状态。
为每个启用的账户提供不同的 `webhookPath`。OpenClaw 现在拒绝重复的精确路径，并拒绝启动仅在多账户设置中继承共享 webhook 路径的命名账户。
如果您有意需要为命名账户保留旧的继承行为，请在该账户或 `channels.synology-chat` 处设置 `dangerouslyAllowInheritedWebhookPath: true`，但重复的精确路径仍然会失败关闭。优先使用明确的每个账户路径。

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

- 保持 `token` 保密，如果泄露请轮换
- 保持 `allowInsecureSsl: false`，除非您明确信任自签名的本地 NAS 证书
- 入站 webhook 请求经过令牌验证并按发送者进行速率限制
- 无效令牌检查使用恒定时间密钥比较并失败关闭
- 生产环境优先使用 `dmPolicy: "allowlist"`
- 除非您明确需要基于旧用户名的回复传递，否则保持 `dangerouslyAllowNameMatching` 关闭
- 除非您在多账户设置中明确接受共享路径路由风险，否则保持 `dangerouslyAllowInheritedWebhookPath` 关闭

## 故障排除

- `Missing required fields (token, user_id, text)`：
  - 出站 webhook 有效负载缺少必需字段之一
  - 如果 Synology 在标头中发送令牌，请确保网关/代理保留这些标头
- `Invalid token`：
  - 出站 webhook 密钥与 `channels.synology-chat.token` 不匹配
  - 请求命中了错误的账户/webhook 路径
  - 反向代理在请求到达 OpenClaw 之前剥离了令牌标头
- `Rate limit exceeded`：
  - 来自同一来源的太多无效令牌尝试可能会暂时锁定该来源
  - 已认证的发送者也有单独的每用户消息速率限制
- `Allowlist is empty. Configure allowedUserIds or use dmPolicy=open.`：
  - `dmPolicy="allowlist"` 已启用但未配置用户
- `User not authorized`：
  - 发送者的数字 `user_id` 不在 `allowedUserIds` 中

## 相关

- [通道概览](/channels) — 所有支持的通道
- [配对](/channels/pairing) — 直接消息认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及限制
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全性](/gateway/security) — 访问模型和加固