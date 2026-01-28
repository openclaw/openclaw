---
read_when: 设置 Slack 或调试 Slack Socket/HTTP 模式
summary: Slack 的 Socket 或 HTTP webhook 模式设置
title: Slack
x-i18n:
  generated_at: "2026-02-01T19:29:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 703b4b4333bebfef26b64710ba452bdfc3e7d2115048d4e552e8659425b3609b
  source_path: channels/slack.md
  workflow: 14
---

# Slack

## Socket 模式（默认）

### 快速设置（新手）

1. 创建一个 Slack 应用并启用 **Socket Mode**。
2. 创建一个 **App Token**（`xapp-...`）和 **Bot Token**（`xoxb-...`）。
3. 为 OpenClaw 设置 token 并启动 Gateway网关。

最小配置：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### 设置

1. 在 https://api.slack.com/apps 创建 Slack 应用（从头开始）。
2. **Socket Mode** → 开启。然后进入 **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**，使用范围 `connections:write`。复制 **App Token**（`xapp-...`）。
3. **OAuth & Permissions** → 添加 bot token 范围（使用下方清单）。点击 **Install to Workspace**。复制 **Bot User OAuth Token**（`xoxb-...`）。
4. 可选：**OAuth & Permissions** → 添加 **User Token Scopes**（参见下方只读列表）。重新安装应用并复制 **User OAuth Token**（`xoxp-...`）。
5. **Event Subscriptions** → 启用事件并订阅：
   - `message.*`（包括编辑/删除/线程广播）
   - `app_mention`
   - `reaction_added`、`reaction_removed`
   - `member_joined_channel`、`member_left_channel`
   - `channel_rename`
   - `pin_added`、`pin_removed`
6. 邀请机器人加入你希望它读取的频道。
7. Slash Commands → 如果你使用 `channels.slack.slashCommand`，创建 `/openclaw`。如果你启用原生命令，为每个内置命令添加一个斜杠命令（名称与 `/help` 列表相同）。Slack 的原生命令默认关闭，除非你设置 `channels.slack.commands.native: true`（全局 `commands.native` 为 `"auto"`，Slack 下默认关闭）。
8. App Home → 启用 **Messages Tab** 以便用户可以给机器人发私信。

使用下方清单以保持范围和事件同步。

多账户支持：使用 `channels.slack.accounts`，每个账户配置独立 token 和可选的 `name`。共享模式请参阅 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。

### OpenClaw 配置（最小）

通过环境变量设置 token（推荐）：

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

或通过配置：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### 用户 token（可选）

OpenClaw 可以使用 Slack 用户 token（`xoxp-...`）进行读取操作（历史记录、置顶、回应、表情、成员信息）。默认保持只读：有用户 token 时读取操作优先使用它，写入仍使用 bot token，除非你明确选择。即使设置了 `userTokenReadOnly: false`，当 bot token 可用时写入操作仍优先使用它。

用户 token 在配置文件中设置（不支持环境变量）。多账户时设置 `channels.slack.accounts.<id>.userToken`。

同时使用 bot + app + user token 的示例：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

显式设置 userTokenReadOnly 的示例（允许用户 token 写入）：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Token 使用

- 读取操作（历史记录、回应列表、置顶列表、表情列表、成员信息、搜索）在配置了用户 token 时优先使用，否则使用 bot token。
- 写入操作（发送/编辑/删除消息、添加/移除回应、置顶/取消置顶、文件上传）默认使用 bot token。如果 `userTokenReadOnly: false` 且没有 bot token 可用，OpenClaw 回退到用户 token。

### 历史上下文

- `channels.slack.historyLimit`（或 `channels.slack.accounts.*.historyLimit`）控制多少条最近的频道/群组消息被包含在提示中。
- 回退到 `messages.groupChat.historyLimit`。设置 `0` 可禁用（默认 50）。

## HTTP 模式（Events API）

当你的 Gateway网关可通过 HTTPS 被 Slack 访问时使用 HTTP webhook 模式（适用于服务器部署）。HTTP 模式使用 Events API + Interactivity + Slash Commands，共享请求 URL。

### 设置

1. 创建 Slack 应用并**禁用 Socket Mode**（如果你只使用 HTTP 则可选）。
2. **Basic Information** → 复制 **Signing Secret**。
3. **OAuth & Permissions** → 安装应用并复制 **Bot User OAuth Token**（`xoxb-...`）。
4. **Event Subscriptions** → 启用事件并将 **Request URL** 设置为你的 Gateway网关 webhook 路径（默认 `/slack/events`）。
5. **Interactivity & Shortcuts** → 启用并设置相同的 **Request URL**。
6. **Slash Commands** → 为你的命令设置相同的 **Request URL**。

示例请求 URL：
`https://gateway-host/slack/events`

### OpenClaw 配置（最小）

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

多账户 HTTP 模式：设置 `channels.slack.accounts.<id>.mode = "http"` 并为每个账户提供唯一的 `webhookPath`，以便每个 Slack 应用可以指向自己的 URL。

### 清单（可选）

使用此 Slack 应用清单可快速创建应用（根据需要调整名称/命令）。如果你计划配置用户 token，请包含用户范围。

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

如果你启用原生命令，为你想暴露的每个命令添加一个 `slash_commands` 条目（匹配 `/help` 列表）。通过 `channels.slack.commands.native` 覆盖。

## 范围（当前 vs 可选）

Slack 的 Conversations API 按类型设定范围：你只需要你实际使用的会话类型（channels、groups、im、mpim）对应的范围。概览请参见 https://docs.slack.dev/apis/web-api/using-the-conversations-api/。

### Bot token 范围（必需）

- `chat:write`（通过 `chat.postMessage` 发送/更新/删除消息）
  https://docs.slack.dev/reference/methods/chat.postMessage
- `im:write`（通过 `conversations.open` 打开用户私信）
  https://docs.slack.dev/reference/methods/conversations.open
- `channels:history`、`groups:history`、`im:history`、`mpim:history`
  https://docs.slack.dev/reference/methods/conversations.history
- `channels:read`、`groups:read`、`im:read`、`mpim:read`
  https://docs.slack.dev/reference/methods/conversations.info
- `users:read`（用户查找）
  https://docs.slack.dev/reference/methods/users.info
- `reactions:read`、`reactions:write`（`reactions.get` / `reactions.add`）
  https://docs.slack.dev/reference/methods/reactions.get
  https://docs.slack.dev/reference/methods/reactions.add
- `pins:read`、`pins:write`（`pins.list` / `pins.add` / `pins.remove`）
  https://docs.slack.dev/reference/scopes/pins.read
  https://docs.slack.dev/reference/scopes/pins.write
- `emoji:read`（`emoji.list`）
  https://docs.slack.dev/reference/scopes/emoji.read
- `files:write`（通过 `files.uploadV2` 上传）
  https://docs.slack.dev/messaging/working-with-files/#upload

### 用户 token 范围（可选，默认只读）

如果你配置了 `channels.slack.userToken`，请在 **User Token Scopes** 下添加这些。

- `channels:history`、`groups:history`、`im:history`、`mpim:history`
- `channels:read`、`groups:read`、`im:read`、`mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### 目前不需要（但未来可能）

- `mpim:write`（仅在我们添加群组私信打开/私信开始功能时需要，通过 `conversations.open`）
- `groups:write`（仅在我们添加私有频道管理时需要：创建/重命名/邀请/归档）
- `chat:write.public`（仅在我们想向机器人未加入的频道发帖时需要）
  https://docs.slack.dev/reference/scopes/chat.write.public
- `users:read.email`（仅在我们需要从 `users.info` 获取邮箱字段时需要）
  https://docs.slack.dev/changelog/2017-04-narrowing-email-access
- `files:read`（仅在我们开始列出/读取文件元数据时需要）

## 配置

Slack 仅使用 Socket Mode（无 HTTP webhook 服务器）。提供两个 token：

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Token 也可以通过环境变量提供：

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

确认回应由 `messages.ackReaction` + `messages.ackReactionScope` 全局控制。使用 `messages.removeAckAfterReply` 在机器人回复后清除确认回应。

## 限制

- 出站文本按 `channels.slack.textChunkLimit` 分块（默认 4000）。
- 可选的换行分块：设置 `channels.slack.chunkMode="newline"` 在按长度分块之前按空行（段落边界）分割。
- 媒体上传上限由 `channels.slack.mediaMaxMb` 限制（默认 20）。

## 回复线程

默认情况下，OpenClaw 在主频道中回复。使用 `channels.slack.replyToMode` 控制自动线程行为：

| 模式    | 行为                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------ |
| `off`   | **默认。** 在主频道回复。仅在触发消息已在线程中时才在线程中回复。                                |
| `first` | 第一条回复进入线程（在触发消息下方），后续回复进入主频道。适用于保持上下文可见同时避免线程杂乱。 |
| `all`   | 所有回复都进入线程。保持对话集中但可能降低可见性。                                               |

该模式同时适用于自动回复和智能体工具调用（`slack sendMessage`）。

### 按聊天类型设置线程

你可以通过设置 `channels.slack.replyToModeByChatType` 为不同聊天类型配置不同的线程行为：

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // 频道默认
      replyToModeByChatType: {
        direct: "all", // 私信始终使用线程
        group: "first", // 群组私信/MPIM 第一条回复使用线程
      },
    },
  },
}
```

支持的聊天类型：

- `direct`：一对一私信（Slack `im`）
- `group`：群组私信 / MPIM（Slack `mpim`）
- `channel`：标准频道（公共/私有）

优先级：

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. 提供商默认值（`off`）

旧版 `channels.slack.dm.replyToMode` 在未设置聊天类型覆盖时仍作为 `direct` 的回退值。

示例：

仅私信使用线程：

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

群组私信使用线程但频道保持在根级：

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

频道使用线程，私信保持在根级：

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### 手动线程标签

对于精细控制，在智能体回复中使用以下标签：

- `[[reply_to_current]]` — 回复触发消息（开始/继续线程）。
- `[[reply_to:<id>]]` — 回复特定消息 ID。

## 会话 + 路由

- 私信共享 `main` 会话（与 WhatsApp/Telegram 类似）。
- 频道映射到 `agent:<agentId>:slack:channel:<channelId>` 会话。
- 斜杠命令使用 `agent:<agentId>:slack:slash:<userId>` 会话（前缀可通过 `channels.slack.slashCommand.sessionPrefix` 配置）。
- 如果 Slack 不提供 `channel_type`，OpenClaw 从频道 ID 前缀（`D`、`C`、`G`）推断并默认为 `channel` 以保持会话键稳定。
- 原生命令注册使用 `commands.native`（全局默认 `"auto"` → Slack 关闭），可通过 `channels.slack.commands.native` 按工作区覆盖。文本命令需要独立的 `/...` 消息，可通过 `commands.text: false` 禁用。Slack 斜杠命令在 Slack 应用中管理，不会自动移除。使用 `commands.useAccessGroups: false` 可绕过命令的访问组检查。
- 完整命令列表 + 配置：[斜杠命令](/tools/slash-commands)

## 私信安全（配对）

- 默认：`channels.slack.dm.policy="pairing"` — 未知私信发送者会收到配对码（1 小时后过期）。
- 通过 `openclaw pairing approve slack <code>` 批准。
- 要允许任何人：设置 `channels.slack.dm.policy="open"` 和 `channels.slack.dm.allowFrom=["*"]`。
- `channels.slack.dm.allowFrom` 接受用户 ID、@用户名或邮箱（启动时当 token 允许时解析）。向导在设置期间当 token 允许时接受用户名并将其解析为 ID。

## 群组策略

- `channels.slack.groupPolicy` 控制频道处理方式（`open|disabled|allowlist`）。
- `allowlist` 需要频道列在 `channels.slack.channels` 中。
- 如果你只设置了 `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` 且从未创建 `channels.slack` 部分，运行时默认将 `groupPolicy` 设为 `open`。添加 `channels.slack.groupPolicy`、`channels.defaults.groupPolicy` 或频道允许列表来锁定它。
- 配置向导接受 `#channel` 名称并在可能时将其解析为 ID（公共 + 私有）；如果存在多个匹配，优先选择活跃频道。
- 启动时，OpenClaw 将允许列表中的频道/用户名称解析为 ID（当 token 允许时）并记录映射；未解析的条目保持原样。
- 要**不允许任何频道**，设置 `channels.slack.groupPolicy: "disabled"`（或保持空的允许列表）。

频道选项（`channels.slack.channels.<id>` 或 `channels.slack.channels.<name>`）：

- `allow`：当 `groupPolicy="allowlist"` 时允许/拒绝频道。
- `requireMention`：频道的提及门控。
- `tools`：可选的按频道工具策略覆盖（`allow`/`deny`/`alsoAllow`）。
- `toolsBySender`：可选的频道内按发送者工具策略覆盖（键为发送者 ID/@用户名/邮箱；支持 `"*"` 通配符）。
- `allowBots`：允许此频道中机器人发送的消息（默认：false）。
- `users`：可选的按频道用户允许列表。
- `skills`：Skills 过滤器（省略 = 所有 Skills，空 = 无）。
- `systemPrompt`：频道的额外系统提示（与主题/目的合并）。
- `enabled`：设置 `false` 可禁用频道。

## 投递目标

在定时任务/CLI 发送中使用：

- `user:<id>` 用于私信
- `channel:<id>` 用于频道

## 工具操作

Slack 工具操作可通过 `channels.slack.actions.*` 控制：

| 操作组     | 默认值 | 说明                |
| ---------- | ------ | ------------------- |
| reactions  | 启用   | 添加回应 + 列出回应 |
| messages   | 启用   | 读取/发送/编辑/删除 |
| pins       | 启用   | 置顶/取消置顶/列出  |
| memberInfo | 启用   | 成员信息            |
| emojiList  | 启用   | 自定义表情列表      |

## 安全注意事项

- 写入操作默认使用 bot token，以便状态变更操作保持在应用机器人权限和身份范围内。
- 设置 `userTokenReadOnly: false` 允许在 bot token 不可用时使用用户 token 进行写入操作，这意味着操作以安装用户的访问权限运行。请将用户 token 视为高权限凭据，并严格设置操作门控和允许列表。
- 如果你启用用户 token 写入，请确保用户 token 包含你预期的写入范围（`chat:write`、`reactions:write`、`pins:write`、`files:write`），否则这些操作会失败。

## 注意事项

- 提及门控通过 `channels.slack.channels` 控制（将 `requireMention` 设为 `true`）；`agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）也算作提及。
- 多智能体覆盖：在 `agents.list[].groupChat.mentionPatterns` 上设置每个智能体的模式。
- 回应通知遵循 `channels.slack.reactionNotifications`（使用 `reactionAllowlist` 配合 `allowlist` 模式）。
- 机器人发送的消息默认被忽略；通过 `channels.slack.allowBots` 或 `channels.slack.channels.<id>.allowBots` 启用。
- 警告：如果你允许回复其他机器人（`channels.slack.allowBots=true` 或 `channels.slack.channels.<id>.allowBots=true`），请使用 `requireMention`、`channels.slack.channels.<id>.users` 允许列表和/或在 `AGENTS.md` 和 `SOUL.md` 中设置明确的防护规则来防止机器人之间的回复循环。
- Slack 工具的回应移除语义请参见 [/tools/reactions](/tools/reactions)。
- 在权限允许且未超过大小限制时，附件会被下载到媒体存储。
