---
read_when:
  - 你想将 OpenClaw 连接到 LINE
  - 你需要 LINE webhook + 凭据设置
  - 你需要 LINE 特定的消息选项
summary: LINE Messaging API 插件设置、配置和使用
title: LINE
x-i18n:
  generated_at: "2026-02-01T19:21:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8fbac126786f95b9454f3cc61906c2798393a8d7914e787d3755c020c7ab2da6
  source_path: channels/line.md
  workflow: 14
---

# LINE（插件）

LINE 通过 LINE Messaging API 连接到 OpenClaw。插件作为 Gateway网关上的 webhook 接收器运行，使用你的频道访问 token + 频道密钥进行认证。

状态：通过插件支持。支持私信、群聊、媒体、位置、Flex 消息、模板消息和快速回复。不支持回应和线程。

## 需要插件

安装 LINE 插件：

```bash
openclaw plugins install @openclaw/line
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/line
```

## 设置

1. 创建 LINE Developers 账户并打开控制台：
   https://developers.line.biz/console/
2. 创建（或选择）一个 Provider 并添加一个 **Messaging API** 频道。
3. 从频道设置中复制 **Channel access token** 和 **Channel secret**。
4. 在 Messaging API 设置中启用 **Use webhook**。
5. 将 webhook URL 设置为你的 Gateway网关端点（需要 HTTPS）：

```
https://gateway-host/line/webhook
```

Gateway网关响应 LINE 的 webhook 验证（GET）和入站事件（POST）。如果你需要自定义路径，请设置 `channels.line.webhookPath` 或 `channels.line.accounts.<id>.webhookPath` 并相应更新 URL。

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

Token/密钥文件：

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

多账户：

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

私信默认需要配对。未知发送者会收到配对码，在批准之前其消息会被忽略。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

允许列表和策略：

- `channels.line.dmPolicy`：`pairing | allowlist | open | disabled`
- `channels.line.allowFrom`：私信的允许 LINE 用户 ID 列表
- `channels.line.groupPolicy`：`allowlist | open | disabled`
- `channels.line.groupAllowFrom`：群组的允许 LINE 用户 ID 列表
- 按群组覆盖：`channels.line.groups.<groupId>.allowFrom`

LINE ID 区分大小写。有效的 ID 格式如下：

- 用户：`U` + 32 位十六进制字符
- 群组：`C` + 32 位十六进制字符
- 房间：`R` + 32 位十六进制字符

## 消息行为

- 文本在 5000 字符处分块。
- Markdown 格式会被去除；代码块和表格在可能时会转换为 Flex 卡片。
- 流式响应会被缓冲；智能体工作时 LINE 接收完整分块并显示加载动画。
- 媒体下载上限由 `channels.line.mediaMaxMb` 限制（默认 10）。

## 渠道数据（富消息）

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
          /* Flex 负载 */
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

LINE 插件还附带一个 `/card` 命令用于 Flex 消息预设：

```
/card info "Welcome" "Thanks for joining!"
```

## 故障排除

- **Webhook 验证失败：** 确保 webhook URL 为 HTTPS 且 `channelSecret` 与 LINE 控制台匹配。
- **没有入站事件：** 确认 webhook 路径与 `channels.line.webhookPath` 匹配且 Gateway网关可从 LINE 访问。
- **媒体下载错误：** 如果媒体超过默认限制，请增大 `channels.line.mediaMaxMb`。
