---
summary: "LINE Messaging API 插件设置、配置和使用"
read_when:
  - 您想将 OpenClaw 连接到 LINE
  - 您需要 LINE webhook + 凭证设置
  - 您需要 LINE 特定的消息选项
title: LINE
---

# LINE

LINE 通过 LINE Messaging API 连接到 OpenClaw。该插件作为网关上的 webhook 接收器运行，并使用您的频道访问令牌 + 频道密钥进行认证。

状态：捆绑插件。支持直接消息、群聊、媒体、位置、Flex 消息、模板消息和快速回复。不支持反应和线程。

## 捆绑插件

LINE 在当前的 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是较旧的构建或排除了 LINE 的自定义安装，请手动安装：

```bash
openclaw plugins install @openclaw/line
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./path/to/local/line-plugin
```

## 设置

1. 创建 LINE Developers 账户并打开控制台：
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 创建（或选择）一个提供商并添加一个**Messaging API**频道。
3. 从频道设置中复制**Channel access token**和**Channel secret**。
4. 在 Messaging API 设置中启用**Use webhook**。
5. 将 webhook URL 设置为您的网关端点（需要 HTTPS）：

```
https://gateway-host/line/webhook
```

网关响应 LINE 的 webhook 验证（GET）和入站事件（POST）。如果您需要自定义路径，请设置 `channels.line.webhookPath` 或 `channels.line.accounts.<id>.webhookPath` 并相应地更新 URL。

安全注意：

- LINE 签名验证依赖于正文（对原始正文进行 HMAC），因此 OpenClaw 在验证之前应用严格的预认证正文限制和超时。
- OpenClaw 从已验证的原始请求字节处理 webhook 事件。为了签名完整性安全，上游中间件转换的 `req.body` 值被忽略。

## 配置

最小配置：

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

环境变量（仅默认账户）：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

令牌/密钥文件：

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

`tokenFile` 和 `secretFile` 必须指向常规文件。拒绝符号链接。

多个账户：

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## 访问控制

直接消息默认为配对。未知发送者会获得一个配对码，他们的消息在批准之前被忽略。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

允许列表和策略：

- `channels.line.dmPolicy`：`pairing | allowlist | open | disabled`
- `channels.line.allowFrom`：DM 的允许列表 LINE 用户 ID
- `channels.line.groupPolicy`：`allowlist | open | disabled`
- `channels.line.groupAllowFrom`：群组的允许列表 LINE 用户 ID
- 每群组覆盖：`channels.line.groups.<groupId>.allowFrom`
- 运行时注意：如果完全缺少 `channels.line`，运行时会回退到 `groupPolicy="allowlist"` 进行群组检查（即使设置了 `channels.defaults.groupPolicy`）。

LINE ID 区分大小写。有效 ID 看起来像：

- 用户：`U` + 32 个十六进制字符
- 群组：`C` + 32 个十六进制字符
- 房间：`R` + 32 个十六进制字符

## 消息行为

- 文本被分块为 5000 个字符。
- Markdown 格式被剥离；代码块和表格在可能的情况下转换为 Flex 卡片。
- 流式响应被缓冲；LINE 在代理工作时接收带有加载动画的完整块。
- 媒体下载受 `channels.line.mediaMaxMb` 限制（默认 10）。

## 频道数据（富消息）

使用 `channelData.line` 发送快速回复、位置、Flex 卡片或模板消息。

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE 插件还提供了 `/card` 命令用于 Flex 消息预设：

```
/card info "Welcome" "Thanks for joining!"
```

## ACP 支持

LINE 支持 ACP（代理通信协议）对话绑定：

- `/acp spawn <agent> --bind here` 将当前 LINE 聊天绑定到 ACP 会话，而不创建子线程。
- 配置的 ACP 绑定和活动的对话绑定 ACP 会话在 LINE 上的工作方式与其他对话频道相同。

有关详细信息，请参见 [ACP agents](/tools/acp-agents)。

## 出站媒体

LINE 插件支持通过代理消息工具发送图像、视频和音频文件。媒体通过 LINE 特定的传递路径发送，具有适当的预览和跟踪处理：

- **图像**：作为 LINE 图像消息发送，带有自动预览生成。
- **视频**：发送时带有明确的预览和内容类型处理。
- **音频**：作为 LINE 音频消息发送。

当 LINE 特定路径不可用时，通用媒体发送会回退到现有的仅图像路径。

## 故障排除

- **Webhook 验证失败**：确保 webhook URL 是 HTTPS，并且 `channelSecret` 与 LINE 控制台匹配。
- **无入站事件**：确认 webhook 路径与 `channels.line.webhookPath` 匹配，并且网关可从 LINE 访问。
- **媒体下载错误**：如果媒体超过默认限制，请提高 `channels.line.mediaMaxMb`。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化