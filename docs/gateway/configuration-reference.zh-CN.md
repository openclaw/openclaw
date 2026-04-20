---
title: "配置参考"
summary: "OpenClaw 核心配置键、默认值的网关配置参考，以及指向专用子系统参考的链接"
read_when:
  - 您需要精确的字段级配置语义或默认值
  - 您正在验证频道、模型、网关或工具配置块
---

# 配置参考

`~/.openclaw/openclaw.json` 的核心配置参考。有关面向任务的概述，请参阅 [配置](/gateway/configuration)。

本页涵盖 OpenClaw 的主要配置表面，并在子系统有自己的深入参考时提供链接。它**不会**尝试在一个页面上内联每个频道/插件拥有的命令目录或每个深层内存/QMD 旋钮。

代码事实：

- `openclaw config schema` 打印用于验证和控制面板的实时 JSON Schema，当可用时合并了捆绑/插件/频道元数据
- `config.schema.lookup` 返回一个路径范围的 schema 节点，用于深入工具
- `pnpm config:docs:check` / `pnpm config:docs:gen` 验证配置文档基线哈希与当前 schema 表面

专用深层参考：

- [内存配置参考](/reference/memory-config) 用于 `agents.defaults.memorySearch.*`、`memory.qmd.*`、`memory.citations` 和 `plugins.entries.memory-core.config.dreaming` 下的做梦配置
- [斜杠命令](/tools/slash-commands) 用于当前内置 + 捆绑命令目录
- 拥有频道/插件页面用于频道特定的命令表面

配置格式为 **JSON5**（允许注释 + 尾随逗号）。所有字段都是可选的 — OpenClaw 在省略时使用安全默认值。

---

## 频道

每个频道在其配置部分存在时自动启动（除非 `enabled: false`）。

### 私信和群组访问

所有频道都支持私信策略和群组策略：

| 私信策略           | 行为                                                        |
| ------------------- | --------------------------------------------------------------- |
| `pairing`（默认） | 未知发送者获得一次性配对代码；所有者必须批准 |
| `allowlist`         | 仅 `allowFrom` 中的发送者（或配对允许存储）             |
| `open`              | 允许所有入站私信（需要 `allowFrom: ["*"]`）             |
| `disabled`          | 忽略所有入站私信                                          |

| 群组策略          | 行为                                               |
| --------------------- | ------------------------------------------------------ |
| `allowlist`（默认） | 仅匹配配置的白名单的群组          |
| `open`                | 绕过群组白名单（提及门控仍然适用） |
| `disabled`            | 阻止所有群组/房间消息                          |

<Note>
`channels.defaults.groupPolicy` 在提供者的 `groupPolicy` 未设置时设置默认值。
配对代码在 1 小时后过期。待处理的私信配对请求上限为每个频道 **3 个**。
如果提供者块完全缺失（`channels.<provider>` 不存在），运行时群组策略会回退到 `allowlist`（失败关闭）并带有启动警告。
</Note>

### 频道模型覆盖

使用 `channels.modelByChannel` 将特定频道 ID 固定到模型。值接受 `provider/model` 或配置的模型别名。当会话尚未有模型覆盖时（例如，通过 `/model` 设置），频道映射适用。

```json5
{
  channels: {
    modelByChannel: {
      discord: {
        "123456789012345678": "anthropic/claude-opus-4-6",
      },
      slack: {
        C1234567890: "openai/gpt-4.1",
      },
      telegram: {
        "-1001234567890": "openai/gpt-4.1-mini",
        "-1001234567890:topic:99": "anthropic/claude-sonnet-4-6",
      },
    },
  },
}
```

### 频道默认值和心跳

使用 `channels.defaults` 跨提供者共享群组策略和心跳行为：

```json5
{
  channels: {
    defaults: {
      groupPolicy: "allowlist", // open | allowlist | disabled
      contextVisibility: "all", // all | allowlist | allowlist_quote
      heartbeat: {
        showOk: false,
        showAlerts: true,
        useIndicator: true,
      },
    },
  },
}
```

- `channels.defaults.groupPolicy`：当提供者级别的 `groupPolicy` 未设置时的回退群组策略。
- `channels.defaults.contextVisibility`：所有频道的默认补充上下文可见性模式。值：`all`（默认，包括所有引用/线程/历史上下文）、`allowlist`（仅包括来自白名单发送者的上下文）、`allowlist_quote`（与 allowlist 相同，但保留显式引用/回复上下文）。每频道覆盖：`channels.<channel>.contextVisibility`。
- `channels.defaults.heartbeat.showOk`：在心跳输出中包含健康频道状态。
- `channels.defaults.heartbeat.showAlerts`：在心跳输出中包含降级/错误状态。
- `channels.defaults.heartbeat.useIndicator`：渲染紧凑的指示器样式心跳输出。

### WhatsApp

WhatsApp 通过网关的 web 频道（Baileys Web）运行。当存在链接会话时，它会自动启动。

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000,
      chunkMode: "length", // length | newline
      mediaMaxMb: 50,
      sendReadReceipts: true, // 蓝勾（在自聊模式下为 false）
      groups: {
        "*": { requireMention: true },
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

<Accordion title="多账户 WhatsApp">

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {},
        personal: {},
        biz: {
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

- 出站命令默认使用账户 `default`（如果存在）；否则使用第一个配置的账户 ID（已排序）。
- 可选的 `channels.whatsapp.defaultAccount` 当与配置的账户 ID 匹配时，覆盖该回退默认账户选择。
- 旧的单账户 Baileys 认证目录由 `openclaw doctor` 迁移到 `whatsapp/default`。
- 每账户覆盖：`channels.whatsapp.accounts.<id>.sendReadReceipts`、`channels.whatsapp.accounts.<id>.dmPolicy`、`channels.whatsapp.accounts.<id>.allowFrom`。

</Accordion>

### Telegram

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing",
      allowFrom: ["tg:123456789"],
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50,
      replyToMode: "first", // off | first | all | batched
      linkPreview: true,
      streaming: "partial", // off | partial | block | progress（默认：off；显式选择以避免预览编辑速率限制）
      actions: { reactions: true, sendMessage: true },
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 100,
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

- 机器人令牌：`channels.telegram.botToken` 或 `channels.telegram.tokenFile`（仅常规文件；拒绝符号链接），默认账户的回退为 `TELEGRAM_BOT_TOKEN`。
- 可选的 `channels.telegram.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。
- 在多账户设置（2+ 账户 ID）中，设置显式默认值（`channels.telegram.defaultAccount` 或 `channels.telegram.accounts.default`）以避免回退路由；当这缺失或无效时，`openclaw doctor` 会发出警告。
- `configWrites: false` 阻止 Telegram 发起的配置写入（超级群组 ID 迁移、`/config set|unset`）。
- 带有 `type: "acp"` 的顶级 `bindings[]` 条目为论坛主题配置持久 ACP 绑定（在 `match.peer.id` 中使用规范的 `chatId:topic:topicId`）。字段语义在 [ACP 代理](/tools/acp-agents#channel-specific-settings) 中共享。
- Telegram 流预览使用 `sendMessage` + `editMessageText`（在直接和群组聊天中工作）。
- 重试策略：见 [重试策略](/concepts/retry)。

### Discord

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 100,
      allowBots: false,
      actions: {
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all | batched
      dmPolicy: "pairing",
      allowFrom: ["1234567890", "123456789012345678"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["openclaw-dm"] },
      guilds: {
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          ignoreOtherMentions: true,
          reactionNotifications: "own",
          users: ["987654321098765432"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20,
      textChunkLimit: 2000,
      chunkMode: "length", // length | newline
      streaming: "off", // off | partial | block | progress（progress 在 Discord 上映射为 partial）
      maxLinesPerMessage: 17,
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSubagentSessions: false, // 为 sessions_spawn({ thread: true }) 选择加入
      },
      voice: {
        enabled: true,
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        tts: {
          provider: "openai",
          openai: { voice: "alloy" },
        },
      },
      execApprovals: {
        enabled: "auto", // true | false | "auto"
        approvers: ["987654321098765432"],
        agentFilter: ["default"],
        sessionFilter: ["discord:"],
        target: "dm", // dm | channel | both
        cleanupAfterResolve: false,
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

- 令牌：`channels.discord.token`，默认账户的回退为 `DISCORD_BOT_TOKEN`。
- 提供显式 Discord `token` 的直接出站调用使用该令牌进行调用；账户重试/策略设置仍然来自活动运行时快照中的选定账户。
- 可选的 `channels.discord.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。
- 使用 `user:<id>`（私信）或 `channel:<id>`（公会频道）作为传递目标；拒绝裸数字 ID。
- 公会 slug 为小写，空格替换为 `-`；频道键使用 slugged 名称（无 `#`）。首选公会 ID。
- 默认忽略机器人撰写的消息。`allowBots: true` 启用它们；使用 `allowBots: "mentions"` 仅接受提及机器人的机器人消息（仍过滤自己的消息）。
- `channels.discord.guilds.<id>.ignoreOtherMentions`（和频道覆盖）丢弃提及其他用户或角色但不提及机器人的消息（不包括 @everyone/@here）。
- `maxLinesPerMessage`（默认 17）即使在 2000 字符以下也会分割高消息。
- `channels.discord.threadBindings` 控制 Discord 线程绑定路由：
  - `enabled`：Discord 对线程绑定会话功能的覆盖（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age` 和绑定传递/路由）
  - `idleHours`：Discord 对不活动自动取消聚焦的覆盖（小时）（`0` 禁用）
  - `maxAgeHours`：Discord 对硬最大年龄的覆盖（小时）（`0` 禁用）
  - `spawnSubagentSessions`：`sessions_spawn({ thread: true })` 自动线程创建/绑定的选择加入开关
- 带有 `type: "acp"` 的顶级 `bindings[]` 条目为频道和线程配置持久 ACP 绑定（在 `match.peer.id` 中使用频道/线程 id）。字段语义在 [ACP 代理](/tools/acp-agents#channel-specific-settings) 中共享。
- `channels.discord.ui.components.accentColor` 设置 Discord 组件 v2 容器的强调色。
- `channels.discord.voice` 启用 Discord 语音频道对话和可选的自动加入 + TTS 覆盖。
- `channels.discord.voice.daveEncryption` 和 `channels.discord.voice.decryptionFailureTolerance` 传递到 `@discordjs/voice` DAVE 选项（默认 `true` 和 `24`）。
- OpenClaw 另外尝试通过在重复解密失败后离开/重新加入语音会话来恢复语音接收。
- `channels.discord.streaming` 是规范的流模式键。旧的 `streamMode` 和布尔 `streaming` 值会自动迁移。
- `channels.discord.autoPresence` 将运行时可用性映射到机器人状态（健康 => 在线，降级 => 空闲，耗尽 => 请勿打扰）并允许可选的状态文本覆盖。
- `channels.discord.dangerouslyAllowNameMatching` 重新启用可变名称/标签匹配（打破玻璃兼容模式）。
- `channels.discord.execApprovals`：Discord 原生执行批准传递和批准者授权。
  - `enabled`：`true`、`false` 或 `"auto"`（默认）。在自动模式下，当批准者可以从 `approvers` 或 `commands.ownerAllowFrom` 解析时，执行批准激活。
  - `approvers`：允许批准执行请求的 Discord 用户 ID。省略时回退到 `commands.ownerAllowFrom`。
  - `agentFilter`：可选的代理 ID 白名单。省略以转发所有代理的批准。
  - `sessionFilter`：可选的会话键模式（子字符串或正则表达式）。
  - `target`：发送批准提示的位置。`"dm"`（默认）发送到批准者私信，`"channel"` 发送到原始频道，`"both"` 发送到两者。当目标包含 `"channel"` 时，按钮仅对已解析的批准者可用。
  - `cleanupAfterResolve`：当 `true` 时，在批准、拒绝或超时后删除批准私信。

**反应通知模式：** `off`（无）、`own`（机器人的消息，默认）、`all`（所有消息）、`allowlist`（来自 `guilds.<id>.users` 的所有消息）。

### Google Chat

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890",
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

- 服务账户 JSON：内联（`serviceAccount`）或基于文件（`serviceAccountFile`）。
- 也支持服务账户 SecretRef（`serviceAccountRef`）。
- 环境回退：`GOOGLE_CHAT_SERVICE_ACCOUNT` 或 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`。
- 使用 `spaces/<spaceId>` 或 `users/<userId>` 作为传递目标。
- `channels.googlechat.dangerouslyAllowNameMatching` 重新启用可变电子邮件主体匹配（打破玻璃兼容模式）。

### Slack

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-",
      appToken: "xapp-",
      dmPolicy: "pairing",
      allowFrom: ["U123", "U456", "*"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["G123"] },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50,
      allowBots: false,
      reactionNotifications: "own",
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all | batched
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      typingReaction: "hourglass_flowing_sand",
      textChunkLimit: 4000,
      chunkMode: "length",
      streaming: {
        mode: "partial", // off | partial | block | progress
        nativeTransport: true, // 当 mode=partial 时使用 Slack 原生流 API
      },
      mediaMaxMb: 20,
      execApprovals: {
        enabled: "auto", // true | false | "auto"
        approvers: ["U123"],
        agentFilter: ["default"],
        sessionFilter: ["slack:"],
        target: "dm", // dm | channel | both
      },
    },
  },
}
```

- **Socket 模式** 需要 `botToken` 和 `appToken`（默认账户环境回退为 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`）。
- **HTTP 模式** 需要 `botToken` 加上 `signingSecret`（在根或每账户）。
- `botToken`、`appToken`、`signingSecret` 和 `userToken` 接受明文
  字符串或 SecretRef 对象。
- Slack 账户快照公开每个凭证的源/状态字段，例如
  `botTokenSource`、`botTokenStatus`、`appTokenStatus`，以及在 HTTP 模式下
  `signingSecretStatus`。`configured_unavailable` 表示账户通过 SecretRef 配置，但当前命令/运行时路径无法解析秘密值。
- `configWrites: false` 阻止 Slack 发起的配置写入。
- 可选的 `channels.slack.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。
- `channels.slack.streaming.mode` 是 Slack 的规范流模式键。`channels.slack.streaming.nativeTransport` 控制 Slack 的原生流传输。旧的 `streamMode`、布尔 `streaming` 和 `nativeStreaming` 值会自动迁移。
- 使用 `user:<id>`（私信）或 `channel:<id>` 作为传递目标。

**反应通知模式：** `off`、`own`（默认）、`all`、`allowlist`（来自 `reactionAllowlist`）。

**线程会话隔离：** `thread.historyScope` 是每线程（默认）或跨频道共享。`thread.inheritParent` 将父频道记录复制到新线程。

- Slack 原生流加上 Slack 助手风格的 "is typing..." 线程状态需要回复线程目标。顶级私信默认保持离线，因此它们使用 `typingReaction` 或正常传递而不是线程风格的预览。
- `typingReaction` 在回复运行时向入站 Slack 消息添加临时反应，然后在完成时删除它。使用 Slack 表情符号短代码，如 `"hourglass_flowing_sand"`。
- `channels.slack.execApprovals`：Slack 原生执行批准传递和批准者授权。与 Discord 相同的架构：`enabled`（`true`/`false`/`"auto"`）、`approvers`（Slack 用户 ID）、`agentFilter`、`sessionFilter` 和 `target`（`"dm"`、`"channel"` 或 `"both"`）。

| 动作组 | 默认 | 说明                  |
| ------------ | ------- | ---------------------- |
| reactions    | 启用 | 反应 + 列出反应 |
| messages     | 启用 | 读/发送/编辑/删除  |
| pins         | 启用 | 固定/取消固定/列出         |
| memberInfo   | 启用 | 成员信息            |
| emojiList    | 启用 | 自定义表情列表      |

### Mattermost

Mattermost 作为插件提供：`openclaw plugins install @openclaw/mattermost`。

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      groups: {
        "*": { requireMention: true },
        "team-channel-id": { requireMention: false },
      },
      commands: {
        native: true, // 选择加入
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // 反向代理/公共部署的可选显式 URL
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

聊天模式：`oncall`（在 @ 提及时响应，默认）、`onmessage`（每条消息）、`onchar`（以触发前缀开始的消息）。

启用 Mattermost 原生命令时：

- `commands.callbackPath` 必须是路径（例如 `/api/channels/mattermost/command`），而不是完整 URL。
- `commands.callbackUrl` 必须解析到 OpenClaw 网关端点并且可从 Mattermost 服务器访问。
- 原生斜杠回调使用 Mattermost 在斜杠命令注册期间返回的每个命令令牌进行身份验证。如果注册失败或未激活任何命令，OpenClaw 会拒绝带有
  `Unauthorized: invalid command token.` 的回调
- 对于私有/tailnet/内部回调主机，Mattermost 可能要求
  `ServiceSettings.AllowedUntrustedInternalConnections` 包含回调主机/域。
  使用主机/域值，而不是完整 URL。
- `channels.mattermost.configWrites`：允许或拒绝 Mattermost 发起的配置写入。
- `channels.mattermost.requireMention`：在频道中回复前需要 `@mention`。
- `channels.mattermost.groups.<channelId>.requireMention`：每频道提及门控覆盖（`"*"` 为默认）。
- 可选的 `channels.mattermost.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。

### Signal

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15555550123", // 可选账户绑定
      dmPolicy: "pairing",
      allowFrom: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      configWrites: true,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50,
    },
  },
}
```

**反应通知模式：** `off`、`own`（默认）、`all`、`allowlist`（来自 `reactionAllowlist`）。

- `channels.signal.account`：将频道启动固定到特定的 Signal 账户身份。
- `channels.signal.configWrites`：允许或拒绝 Signal 发起的配置写入。
- 可选的 `channels.signal.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。

### BlueBubbles

BlueBubbles 是推荐的 iMessage 路径（插件支持，在 `channels.bluebubbles` 下配置）。

```json5
{
  channels: {
    bluebubbles: {
      enabled: true,
      dmPolicy: "pairing",
      // serverUrl, password, webhookPath, group controls, and advanced actions:
      // see /channels/bluebubbles
    },
  },
}
```

- 这里涵盖的核心键路径：`channels.bluebubbles`、`channels.bluebubbles.dmPolicy`。
- 可选的 `channels.bluebubbles.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。
- 带有 `type: "acp"` 的顶级 `bindings[]` 条目可以将 BlueBubbles 对话绑定到持久 ACP 会话。在 `match.peer.id` 中使用 BlueBubbles 句柄或目标字符串（`chat_id:*`、`chat_guid:*`、`chat_identifier:*`）。共享字段语义：[ACP 代理](/tools/acp-agents#channel-specific-settings)。
- 完整的 BlueBubbles 频道配置在 [BlueBubbles](/channels/bluebubbles) 中记录。

### iMessage

OpenClaw 生成 `imsg rpc`（通过 stdio 的 JSON-RPC）。不需要守护进程或端口。

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host",
      dmPolicy: "pairing",
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50,
      includeAttachments: false,
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

- 可选的 `channels.imessage.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。

- 需要对 Messages DB 的全盘访问权限。
- 首选 `chat_id:<id>` 目标。使用 `imsg chats --limit 20` 列出聊天。
- `cliPath` 可以指向 SSH 包装器；设置 `remoteHost`（`host` 或 `user@host`）用于 SCP 附件获取。
- `attachmentRoots` 和 `remoteAttachmentRoots` 限制入站附件路径（默认：`/Users/*/Library/Messages/Attachments`）。
- SCP 使用严格的主机密钥检查，因此确保中继主机密钥已经存在于 `~/.ssh/known_hosts` 中。
- `channels.imessage.configWrites`：允许或拒绝 iMessage 发起的配置写入。
- 带有 `type: "acp"` 的顶级 `bindings[]` 条目可以将 iMessage 对话绑定到持久 ACP 会话。在 `match.peer.id` 中使用标准化句柄或显式聊天目标（`chat_id:*`、`chat_guid:*`、`chat_identifier:*`）。共享字段语义：[ACP 代理](/tools/acp-agents#channel-specific-settings)。

<Accordion title="iMessage SSH 包装器示例">

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

</Accordion>

### Matrix

Matrix 由扩展支持，在 `channels.matrix` 下配置。

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_bot_xxx",
      proxy: "http://127.0.0.1:7890",
      encryption: true,
      initialSyncLimit: 20,
      defaultAccount: "ops",
      accounts: {
        ops: {
          name: "Ops",
          userId: "@ops:example.org",
          accessToken: "syt_ops_xxx",
        },
        alerts: {
          userId: "@alerts:example.org",
          password: "secret",
          proxy: "http://127.0.0.1:7891",
        },
      },
    },
  },
}
```

- 令牌认证使用 `accessToken`；密码认证使用 `userId` + `password`。
- `channels.matrix.proxy` 通过显式 HTTP(S) 代理路由 Matrix HTTP 流量。命名账户可以使用 `channels.matrix.accounts.<id>.proxy` 覆盖它。
- `channels.matrix.network.dangerouslyAllowPrivateNetwork` 允许私有/内部 homeserver。`proxy` 和此网络选择加入是独立控制。
- `channels.matrix.defaultAccount` 在多账户设置中选择首选账户。
- `channels.matrix.autoJoin` 默认设置为 `off`，因此邀请的房间和新的私信式邀请会被忽略，直到您设置 `autoJoin: "allowlist"` 和 `autoJoinAllowlist` 或 `autoJoin: "always"`。
- `channels.matrix.execApprovals`：Matrix 原生执行批准传递和批准者授权。
  - `enabled`：`true`、`false` 或 `"auto"`（默认）。在自动模式下，当批准者可以从 `approvers` 或 `commands.ownerAllowFrom` 解析时，执行批准激活。
  - `approvers`：允许批准执行请求的 Matrix 用户 ID（例如 `@owner:example.org`）。
  - `agentFilter`：可选的代理 ID 白名单。省略以转发所有代理的批准。
  - `sessionFilter`：可选的会话键模式（子字符串或正则表达式）。
  - `target`：发送批准提示的位置。`"dm"`（默认）、`"channel"`（原始房间）或 `"both"`。
  - 每账户覆盖：`channels.matrix.accounts.<id>.execApprovals`。
- `channels.matrix.dm.sessionScope` 控制 Matrix 私信如何分组到会话中：`per-user`（默认）按路由对等方共享，而 `per-room` 隔离每个私信房间。
- Matrix 状态探测和实时目录查找使用与运行时流量相同的代理策略。
- 完整的 Matrix 配置、目标规则和设置示例在 [Matrix](/channels/matrix) 中记录。

### Microsoft Teams

Microsoft Teams 由扩展支持，在 `channels.msteams` 下配置。

```json5
{
  channels: {
    msteams: {
      enabled: true,
      configWrites: true,
      // appId, appPassword, tenantId, webhook, team/channel policies:
      // see /channels/msteams
    },
  },
}
```

- 这里涵盖的核心键路径：`channels.msteams`、`channels.msteams.configWrites`。
- 完整的 Teams 配置（凭据、webhook、私信/群组策略、每团队/每频道覆盖）在 [Microsoft Teams](/channels/msteams) 中记录。

### IRC

IRC 由扩展支持，在 `channels.irc` 下配置。

```json5
{
  channels: {
    irc: {
      enabled: true,
      dmPolicy: "pairing",
      configWrites: true,
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "${IRC_NICKSERV_PASSWORD}",
        register: false,
        registerEmail: "bot@example.com",
      },
    },
  },
}
```

- 这里涵盖的核心键路径：`channels.irc`、`channels.irc.dmPolicy`、`channels.irc.configWrites`、`channels.irc.nickserv.*`。
- 可选的 `channels.irc.defaultAccount` 当与配置的账户 ID 匹配时，覆盖默认账户选择。
- 完整的 IRC 频道配置（主机/端口/TLS/频道/白名单/提及门控）在 [IRC](/channels/irc) 中记录。

### 多账户（所有频道）

每个频道运行多个账户（每个都有自己的 `accountId`）：

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

- `default` 在省略 `accountId` 时使用（CLI + 路由）。
- 环境令牌仅适用于**默认**账户。
- 基础频道设置适用于所有账户，除非按账户覆盖。
- 使用 `bindings[].match.accountId` 将每个账户路由到不同的代理。
- 如果您在仍处于单账户顶级频道配置时通过 `openclaw channels add`（或频道引导）添加非默认账户，OpenClaw 首先将账户范围的顶级单账户值提升到频道账户映射中，以便原始账户继续工作。大多数频道将它们移动到 `channels.<channel>.accounts.default`；Matrix 可以保留现有的匹配命名/默认目标。
- 现有的仅频道绑定（无 `accountId`）保持匹配默认账户；账户范围的绑定仍然是可选的。
- `openclaw doctor --fix` 还通过将账户范围的顶级单账户值移动到为该频道选择的提升账户中来修复混合形状。大多数频道使用 `accounts.default`；Matrix 可以保留现有的匹配命名/默认目标。

### 其他扩展频道

许多扩展频道配置为 `channels.<id>` 并在其专用频道页面中记录（例如 Feishu、Matrix、LINE、Nostr、Zalo、Nextcloud Talk、Synology Chat 和 Twitch）。
请参阅完整的频道索引：[频道](/channels)。

### 群组聊天提及门控

群组消息默认为**需要提及**（元数据提及或安全正则表达式模式）。适用于 WhatsApp、Telegram、Discord、Google Chat 和 iMessage 群组聊天。

**提及类型：**

- **元数据提及**：原生平台 @-提及。在 WhatsApp 自聊模式中被忽略。
- **文本模式**：`agents.list[].groupChat.mentionPatterns` 中的安全正则表达式模式。无效模式和不安全的嵌套重复被忽略。
- 仅当检测可能时（原生提及或至少一个模式）才强制执行提及门控。

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` 设置全局默认值。频道可以使用 `channels.<channel>.historyLimit`（或每账户）覆盖。设置 `0` 以禁用。

#### 私信历史限制

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30,
      dms: {
        "123456789": { historyLimit: 50 },
      },
    },
  },
}
```

解析：每私信覆盖 → 提供者默认 → 无限制（全部保留）。

支持：`telegram`、`whatsapp`、`discord`、`slack`、`signal`、`imessage`、`msteams`。

#### 自聊模式

在 `allowFrom` 中包含您自己的号码以启用自聊模式（忽略原生 @-提及，仅响应文本模式）：

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["reisponde", "@openclaw"] },
      },
    ],
  },
}
```

### 命令（聊天命令处理）

```json5
{
  commands: {
    native: "auto", // 在支持时注册原生命令
    nativeSkills: "auto", // 在支持时注册原生技能命令
    text: true, // 在聊天消息中解析 /commands
    bash: false, // 允许 !（别名：/bash）
    bashForegroundMs: 2000,
    config: false, // 允许 /config
    mcp: false, // 允许 /mcp
    plugins: false, // 允许 /plugins
    debug: false, // 允许 /debug
    restart: true, // 允许 /restart + 网关重启工具
    ownerAllowFrom: ["discord:123456789012345678"],
    ownerDisplay: "raw", // raw | hash
    ownerDisplaySecret: "${OWNER_ID_HASH_SECRET}",
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

<Accordion title="命令详细信息">

- 此块配置命令表面。有关当前内置 + 捆绑命令目录，请参阅 [斜杠命令](/tools/slash-commands)。
- 此页面是**配置键参考**，不是完整的命令目录。频道/插件拥有的命令，如 QQ Bot `/bot-ping` `/bot-help` `/bot-logs`、LINE `/card`、设备配对 `/pair`、内存 `/dreaming`、电话控制 `/phone` 和 Talk `/voice` 在其频道/插件页面以及 [斜杠命令](/tools/slash-commands) 中记录。
- 文本命令必须是**独立**消息，开头带有 `/`。
- `native: "auto"` 为 Discord/Telegram 开启原生命令，为 Slack 关闭。
- `nativeSkills: "auto"` 为 Discord/Telegram 开启原生技能命令，为 Slack 关闭。
- 按频道覆盖：`channels.discord.commands.native`（布尔值或 `"auto"`）。`false` 清除先前注册的命令。
- 按频道覆盖原生技能注册，使用 `channels.<provider>.commands.nativeSkills`。
- `channels.telegram.customCommands` 添加额外的 Telegram 机器人菜单条目。
- `bash: true` 启用 `! <cmd>` 用于主机 shell。需要 `tools.elevated.enabled` 和发送者在 `tools.elevated.allowFrom.<channel>` 中。
- `config: true` 启用 `/config`（读取/写入 `openclaw.json`）。对于网关 `chat.send` 客户端，持久 `/config set|unset` 写入还需要 `operator.admin`；只读 `/config show` 对正常写入范围的操作员客户端仍然可用。
- `mcp: true` 启用 `/mcp` 用于 `mcp.servers` 下的 OpenClaw 管理的 MCP 服务器配置。
- `plugins: true` 启用 `/plugins` 用于插件发现、安装和启用/禁用控制。
- `channels.<provider>.configWrites` 按频道控制配置突变（默认：true）。
- 对于多账户频道，`channels.<provider>.accounts.<id>.configWrites` 还控制针对该账户的写入（例如 `/allowlist --config --account <id>` 或 `/config set channels.<provider>.accounts.<id>...`）。
- `restart: false` 禁用 `/restart` 和网关重启工具操作。默认：`true`。
- `ownerAllowFrom` 是所有者专用命令/工具的显式所有者白名单。它与 `allowFrom` 分开。
- `ownerDisplay: "hash"` 在系统提示中哈希所有者 ID。设置 `ownerDisplaySecret` 以控制哈希。
- `allowFrom` 是按提供者的。设置后，它是**唯一**的授权源（频道白名单/配对和 `useAccessGroups` 被忽略）。
- `useAccessGroups: false` 当未设置 `allowFrom` 时允许命令绕过访问组策略。
- 命令文档映射：
  - 内置 + 捆绑目录：[斜杠命令](/tools/slash-commands)
  - 频道特定命令表面：[频道](/channels)
  - QQ Bot 命令：[QQ Bot](/channels/qqbot)
  - 配对命令：[配对](/channels/pairing)
  - LINE 卡片命令：[LINE](/channels/line)
  - 内存做梦：[做梦](/concepts/dreaming)

</Accordion>

---

## 代理默认值

### `agents.defaults.workspace`

默认值：`~/.openclaw/workspace`。

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

### `agents.defaults.repoRoot`

系统提示的 Runtime 行中显示的可选存储库根目录。如果未设置，OpenClaw 通过从工作区向上遍历自动检测。

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skills`

未设置 `agents.list[].skills` 的代理的可选默认技能白名单。

```json5
{
  agents: {
    defaults: { skills: ["github", "weather"] },
    list: [
      { id: "writer" }, // 继承 github, weather
      { id: "docs", skills: ["docs-search"] }, // 替换默认值
      { id: "locked-down", skills: [] }, // 无技能
    ],
  },
}
```

- 省略 `agents.defaults.skills` 默认无限制技能。
- 省略 `agents.list[].skills` 以继承默认值。
- 设置 `agents.list[].skills: []` 无技能。
- 非空 `agents.list[].skills` 列表是该代理的最终集合；它
  不与默认值合并。

### `agents.defaults.skipBootstrap`

禁用自动创建工作区引导文件（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`）。

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.contextInjection`

控制工作区引导文件何时注入到系统提示中。默认：`"always"`。

- `"continuation-skip"`：安全的继续回合（在完成的助手响应之后）跳过工作区引导重新注入，减少提示大小。心跳运行和后压缩重试仍然重建上下文。

```json5
{
  agents: { defaults: { contextInjection: "continuation-skip" } },
}
```

### `agents.defaults.bootstrapMaxChars`

截断前每个工作区引导文件的最大字符数。默认：`12000`。

```json5
{
  agents: { defaults: { bootstrapMaxChars: 12000 } },
}
```

### `agents.defaults.bootstrapTotalMaxChars`

所有工作区引导文件注入的最大总字符数。默认：`60000`。

```json5
{
  agents: { defaults: { bootstrapTotalMaxChars: 60000 } },
}
```

### `agents.defaults.bootstrapPromptTruncationWarning`

控制当引导上下文被截断时代理可见的警告文本。
默认：`"once"`。

- `"off"`：永远不向系统提示注入警告文本。
- `"once"`：每个唯一的截断签名注入一次警告（推荐）。
- `"always"`：当存在截断时，每次运行都注入警告。

```json5
{
  agents: { defaults: { bootstrapPromptTruncationWarning: "once" } }, // off | once | always
}
```

### 上下文预算所有权映射

OpenClaw 有多个高容量提示/上下文预算，它们被
有意按子系统拆分，而不是全部通过一个通用
旋钮流动。

- `agents.defaults.bootstrapMaxChars` /
  `agents.defaults.bootstrapTotalMaxChars`：
  正常工作区引导注入。
- `agents.defaults.startupContext.*`：
  一次性 `/new` 和 `/reset` 启动前奏，包括最近的每日
  `memory/*.md` 文件。
- `skills.limits.*`：
  注入到系统提示中的紧凑技能列表。
- `agents.defaults.contextLimits.*`：
  有界运行时摘录和注入的运行时拥有的块。
- `memory.qmd.limits.*`：
  索引内存搜索片段和注入大小调整。

仅当一个代理需要不同的
预算时，使用匹配的每代理覆盖：

- `agents.list[].skillsLimits.maxSkillsPromptChars`
- `agents.list[].contextLimits.*`

#### `agents.defaults.startupContext`

控制在裸 `/new` 和 `/reset`
运行时注入的第一回合启动前奏。

```json5
{
  agents: {
    defaults: {
      startupContext: {
        enabled: true,
        applyOn: ["new", "reset"],
        dailyMemoryDays: 2,
        maxFileBytes: 16384,
        maxFileChars: 1200,
        maxTotalChars: 2800,
      },
    },
  },
}
```

#### `agents.defaults.contextLimits`

共享有界运行时上下文表面的默认值。

```json5
{
  agents: {
    defaults: {
      contextLimits: {
        memoryGetMaxChars: 12000,
        memoryGetDefaultLines: 120,
        toolResultMaxChars: 16000,
        postCompactionMaxChars: 1800,
      },
    },
  },
}
```

- `memoryGetMaxChars`：默认 `memory_get` 摘录上限，然后添加截断
  元数据和继续通知。
- `memoryGetDefaultLines`：当 `lines` 被
  省略时，默认 `memory_get` 行窗口。
- `toolResultMaxChars`：用于持久化结果和
  溢出恢复的实时工具结果上限。
- `postCompactionMaxChars`：在后压缩
  刷新注入期间使用的 AGENTS.md 摘录上限。

#### `agents.list[].contextLimits`

共享 `contextLimits` 旋钮的每代理覆盖。省略的字段继承
自 `agents.defaults.contextLimits`。

```json5
{
  agents: {
    defaults: {
      contextLimits: {
        memoryGetMaxChars: 12000,
        toolResultMaxChars: 16000,
      },
    },
    list: [
      {
        id: "tiny-local",
        contextLimits: {
          memoryGetMaxChars: 6000,
          toolResultMaxChars: 8000,
        },
      },
    ],
  },
}
```

#### `skills.limits.maxSkillsPromptChars`

注入到系统提示中的紧凑技能列表的全局上限。这不影响按需读取 `SKILL.md` 文件。

```json5
{
  skills: {
    limits: {
      maxSkillsPromptChars: 18000,
    },
  },
}
```

#### `agents.list[].skillsLimits.maxSkillsPromptChars`

技能提示预算的每代理覆盖。

```json5
{
  agents: {
    list: [
      {
        id: "tiny-local",
        skillsLimits: {
          maxSkillsPromptChars: 6000,
        },
      },
    ],
  },
}
```

### `agents.defaults.imageMaxDimensionPx`

提供者调用前，转录/工具图像块中最长图像边的最大像素大小。
默认：`1200`。

较低的值通常减少视觉令牌使用和屏幕截图密集运行的请求有效负载大小。
较高的值保留更多视觉细节。

```json5
{
  agents: { defaults: { imageMaxDimensionPx: 1200 } },
}
```

### `agents.defaults.userTimezone`

系统提示上下文的时区（不是消息时间戳）。回退到主机时区。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

系统提示中的时间格式。默认：`auto`（OS 偏好）。

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `agents.defaults.model`

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
        fallbacks: ["google/gemini-3.1-flash-image-preview"],
      },
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-i2v"],
      },
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4-mini"],
      },
      params: { cacheRetention: "long" }, // 全局默认提供者参数
      embeddedHarness: {
        runtime: "auto", // auto | pi | 注册的 harness id，例如 codex
        fallback: "pi", // pi | none
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      contextTokens: 200000,
      maxConcurrent: 3,
    },
  },
}
```

- `model`：接受字符串（`"provider/model"`）或对象（`{ primary, fallbacks }`）。
  - 字符串形式仅设置主模型。
  - 对象形式设置主模型加上有序故障转移模型。
- `imageModel`：接受字符串（`"provider/model"`）或对象（`{ primary, fallbacks }`）。
  - 由 `image` 工具路径用作其视觉模型配置。
  - 当所选/默认模型无法接受图像输入时，也用作回退路由。
- `imageGenerationModel`：接受字符串（`"provider/model"`）或对象（`{ primary, fallbacks }`）。
  - 由共享图像生成功能和任何未来生成图像的工具/插件表面使用。
  - 典型值：`google/gemini-3.1-flash-image-preview` 用于原生 Gemini 图像生成，`fal/fal-ai/flux/dev` 用于 fal，或 `openai/gpt-image-1` 用于 OpenAI 图像。
  - 如果直接选择提供者/模型，请同时配置匹配的提供者认证/API 密钥（例如 `google/*` 的 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`，`openai/*` 的 `OPENAI_API_KEY`，`fal/*` 的 `FAL_KEY`）。
  - 如果省略，`image_generate` 仍然可以推断认证支持的提供者默认值。它首先尝试当前默认提供者，然后按提供者 ID 顺序尝试剩余的注册图像生成提供者。
- `musicGenerationModel`：接受字符串（`"provider/model"`）或对象（`{ primary, fallbacks }`）。
  - 由共享音乐生成功能和内置 `music_generate` 工具使用。
  - 典型值：`google/lyria-3-clip-preview`、`google/lyria-3-pro-preview` 或 `minimax/music-2.5+`。
  - 如果省略，`music_generate` 仍然可以推断认证支持的提供者默认值。它首先尝试当前默认提供者，然后按提供者 ID 顺序尝试剩余的注册音乐生成提供者。
  - 如果直接选择提供者/模型，请同时配置匹配的提供者认证/API 密钥。
- `videoGenerationModel`：接受字符串（`"provider/model"`）或对象（`{ primary, fallbacks }`）。
  - 由共享视频生成功能和内置 `video_generate` 工具使用。
  - 典型值：`qwen/wan2.6-t2v`、`qwen/wan2.6-i2v`、`qwen/wan2.6-r2v`、`qwen/wan2.6-r2v-flash` 或 `qwen/wan2.7-r2v`。
  - 如果省略，`video_generate` 仍然可以推断认证支持的提供者默认值。它首先尝试当前默认提供者，然后按提供者 ID 顺序尝试剩余的注册视频生成提供者。
  - 如果直接选择提供者/模型，请同时配置匹配的提供者认证/API 密钥。
  - 捆绑的 Qwen 视频生成提供者支持最多 1 个输出视频、1 个输入图像、4 个输入视频、10 秒持续时间，以及提供者级别的 `size`、`aspectRatio`、`resolution`、`audio` 和 `watermark` 选项。
- `pdfModel`：接受字符串（`"provider/model"`）或对象（`{ primary, fallbacks }`）。
  - 由 `pdf` 工具用于模型路由。
  - 如果省略，PDF 工具会回退到 `imageModel`，然后到解析的会话/默认模型。
- `pdfMaxBytesMb`：当 `maxBytesMb` 未在调用时传递时，`pdf` 工具的默认 PDF 大小限制。
- `pdfMaxPages`：`pdf` 工具中提取回退模式考虑的默认最大页数。
- `verboseDefault`：代理的默认详细级别。值：`"off"`、`"on"`、`"full"`。默认：`"off"`。
- `elevatedDefault`：代理的默认高级输出级别。值：`"off"`、`"on"`、`"ask"`、`"full"`。默认：`"on"`。
- `model.primary`：格式 `provider/model`（例如 `openai/gpt-5.4`）。如果省略提供者，OpenClaw 首先尝试别名，然后是该确切模型 ID 的唯一配置提供者匹配，然后才回退到配置的默认提供者（已弃用的兼容行为，因此首选显式 `provider/model`）。如果该提供者不再公开配置的默认模型，OpenClaw 会回退到第一个配置的提供者/模型，而不是显示过时的已删除提供者默认值。
- `models`：`/model` 的配置模型目录和白名单。每个条目可以包括 `alias`（快捷方式）和 `params`（提供者特定，例如 `temperature`、`maxTokens`、`cacheRetention`、`context1m`）。
- `params`：应用于所有模型的全局默认提供者参数。在 `agents.defaults.params` 设置（例如 `{ cacheRetention: "long" }`）。
- `params` 合并优先级（配置）：`agents.defaults.params`（全局基础）被 `agents.defaults.models["provider/model"].params`（每模型）覆盖，然后 `agents.list[].params`（匹配代理 ID）按键覆盖。详见 [提示缓存](/reference/prompt-caching)。
- `embeddedHarness`：默认低级嵌入式代理运行时策略。使用 `runtime: "auto"` 让注册的插件 harness 声明支持的模型，`runtime: "pi"` 强制使用内置 PI harness，或注册的 harness id，例如 `runtime: "codex"`。设置 `fallback: "none"` 禁用自动 PI 回退。
- 改变这些字段的配置写入器（例如 `/models set`、`/models set-image` 和回退添加/删除命令）保存规范对象形式并在可能时保留现有回退列表。
- `maxConcurrent`：跨会话的最大并行代理运行（每个会话仍然序列化）。默认：4。

### `agents.defaults.embeddedHarness`

`embeddedHarness` 控制哪个低级执行器运行嵌入式代理回合。
大多数部署应保持默认 `{ runtime: "auto", fallback: "pi" }`。
当受信任的插件提供原生 harness 时使用它，例如捆绑的
Codex 应用服务器 harness。

```json5
{
  agents: {
    defaults: {
      model: "codex/gpt-5.4",
      embeddedHarness: {
        runtime: "codex",
        fallback: "none",
      },
    },
  },
}
```

- `runtime`：`"auto"`、`"pi"` 或注册的插件 harness id。捆绑的 Codex 插件注册 `codex`。
- `fallback`：`"pi"` 或 `"none"`。`"pi"` 将内置 PI harness 保持为兼容性回退。`"none"` 使缺失或不支持的插件 harness 选择失败，而不是静默使用 PI。
- 环境覆盖：`OPENCLAW_AGENT_RUNTIME=<id|auto|pi>` 覆盖 `runtime`；`OPENCLAW_AGENT_HARNESS_FALLBACK=none` 禁用该进程的 PI 回退。