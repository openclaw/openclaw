---
read_when:
  - 你想将 OpenClaw 连接到 LINE
  - 你需要配置 LINE webhook + 凭证
  - 你想了解 LINE 特有的消息选项
summary: LINE Messaging API 插件的配置、设置和使用方法
title: LINE
x-i18n:
  generated_at: "2026-02-03T07:43:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8fbac126786f95b9454f3cc61906c2798393a8d7914e787d3755c020c7ab2da6
  source_path: channels/line.md
  workflow: 15
---

# LINE（插件）

LINE 通过 LINE Messaging API 连接到 OpenClaw。该插件作为 webhook 接收器在 Gateway 网关上运行，使用你的 channel access token + channel secret 进行身份验证。

状态：通过插件支持。支持私信、群聊、媒体、位置、Flex 消息、模板消息和快捷回复。不支持表情回应和话题回复。

## 需要安装插件

安装 LINE 插件：

```bash
openclaw plugins install @openclaw/line
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/line
```

## 配置步骤

1. 创建 LINE Developers 账户并打开控制台：
   https://developers.line.biz/console/
2. 创建（或选择）一个 Provider 并添加 **Messaging API** 渠道。
3. 从渠道设置中复制 **Channel access token** 和 **Channel secret**。
4. 在 Messaging API 设置中启用 **Use webhook**。
5. 将 webhook URL 设置为你的 Gateway 网关端点（必须使用 HTTPS）：

```
https://gateway-host/line/webhook
```

Gateway 网关会响应 LINE 的 webhook 验证（GET）和入站事件（POST）。如果你需要自定义路径，请设置 `channels.line.webhookPath` 或 `channels.line.accounts.<id>.webhookPath` 并相应更新 URL。

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

环境变量（仅限默认账户）：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token/secret 文件：

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

多账户配置：

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

私信默认使用配对模式。未知发送者会收到配对码，其消息在获得批准前会被忽略。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

允许列表和策略：

- `channels.line.dmPolicy`：`pairing | allowlist | open | disabled`
- `channels.line.allowFrom`：私信的允许列表 LINE 用户 ID
- `channels.line.groupPolicy`：`allowlist | open | disabled`
- `channels.line.groupAllowFrom`：群组的允许列表 LINE 用户 ID
- 单群组覆盖：`channels.line.groups.<groupId>.allowFrom`

LINE ID 区分大小写。有效 ID 格式如下：

- 用户：`U` + 32 位十六进制字符
- 群组：`C` + 32 位十六进制字符
- 房间：`R` + 32 位十六进制字符

## 消息行为

- 文本按 5000 字符分块。
- Markdown 格式会被移除；代码块和表格会尽可能转换为 Flex 卡片。
- 流式响应会被缓冲；智能体处理时，LINE 会收到完整分块并显示加载动画。
- 媒体下载受 `channels.line.mediaMaxMb` 限制（默认 10）。

## 渠道数据（富消息）

使用 `channelData.line` 发送快捷回复、位置、Flex 卡片或模板消息。

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

LINE 插件还提供 `/card` 命令用于 Flex 消息预设：

```
/card info "Welcome" "Thanks for joining!"
```

## 故障排除

- **Webhook 验证失败：** 确保 webhook URL 使用 HTTPS 且 `channelSecret` 与 LINE 控制台中的一致。
- **没有入站事件：** 确认 webhook 路径与 `channels.line.webhookPath` 匹配，且 Gateway 网关可从 LINE 访问。
- **媒体下载错误：** 如果媒体超过默认限制，请提高 `channels.line.mediaMaxMb`。
