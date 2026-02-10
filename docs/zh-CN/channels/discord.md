---
read_when:
  - 开发 Discord 渠道功能时
summary: Discord 机器人支持状态、功能和配置
title: Discord
x-i18n:
  generated_at: "2026-02-03T07:45:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2f0083b55648f9158668b80d078353421e7dc310135fdc43f2d280b242bf8459
  source_path: channels/discord.md
  workflow: 15
---

# Discord（Bot API）

状态：已支持通过官方 Discord 机器人网关进行私信和服务器文字频道通信。

## 快速设置（新手）

1. 创建 Discord 机器人并复制机器人令牌。
2. 在 Discord 应用设置中启用 **Message Content Intent**（如果你计划使用允许列表或名称查找，还需启用 **Server Members Intent**）。
3. 为 OpenClaw 设置令牌：
   - 环境变量：`DISCORD_BOT_TOKEN=...`
   - 或配置：`channels.discord.token: "..."`。
   - 如果两者都设置，配置优先（环境变量回退仅适用于默认账户）。
4. 使用消息权限邀请机器人到你的服务器（如果你只想使用私信，可以创建一个私人服务器）。
5. 启动 Gateway 网关。
6. 私信访问默认采用配对模式；首次联系时需批准配对码。

最小配置：

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## 目标

- 通过 Discord 私信或服务器频道与 OpenClaw 对话。
- 直接聊天会合并到智能体的主会话（默认 `agent:main:main`）；服务器频道保持隔离为 `agent:<agentId>:discord:channel:<channelId>`（显示名称使用 `discord:<guildSlug>#<channelSlug>`）。
- 群组私信默认被忽略；通过 `channels.discord.dm.groupEnabled` 启用，并可选择通过 `channels.discord.dm.groupChannels` 进行限制。
- 保持路由确定性：回复始终返回到消息来源的渠道。

## 工作原理

1. 创建 Discord 应用程序 → Bot，启用你需要的意图（私信 + 服务器消息 + 消息内容），并获取机器人令牌。
2. 使用所需权限邀请机器人到你的服务器，以便在你想使用的地方读取/发送消息。
3. 使用 `channels.discord.token` 配置 OpenClaw（或使用 `DISCORD_BOT_TOKEN` 作为回退）。
4. 运行 Gateway 网关；当令牌可用（配置优先，环境变量回退）且 `channels.discord.enabled` 不为 `false` 时，它会自动启动 Discord 渠道。
   - 如果你更喜欢使用环境变量，设置 `DISCORD_BOT_TOKEN`（配置块是可选的）。
5. 直接聊天：发送时使用 `user:<id>`（或 `<@id>` 提及）；所有对话都进入共享的 `main` 会话。纯数字 ID 是模糊的，会被拒绝。
6. 服务器频道：发送时使用 `channel:<channelId>`。默认需要提及，可以按服务器或按频道设置。
7. 直接聊天：默认通过 `channels.discord.dm.policy` 进行安全保护（默认：`"pairing"`）。未知发送者会收到配对码（1 小时后过期）；通过 `openclaw pairing approve discord <code>` 批准。
   - 要保持旧的"对任何人开放"行为：设置 `channels.discord.dm.policy="open"` 和 `channels.discord.dm.allowFrom=["*"]`。
   - 要使用硬编码允许列表：设置 `channels.discord.dm.policy="allowlist"` 并在 `channels.discord.dm.allowFrom` 中列出发送者。
   - 要忽略所有私信：设置 `channels.discord.dm.enabled=false` 或 `channels.discord.dm.policy="disabled"`。
8. 群组私信默认被忽略；通过 `channels.discord.dm.groupEnabled` 启用，并可选择通过 `channels.discord.dm.groupChannels` 进行限制。
9. 可选服务器规则：设置 `channels.discord.guilds`，以服务器 ID（首选）或 slug 为键，并包含每个频道的规则。
10. 可选原生命令：`commands.native` 默认为 `"auto"`（Discord/Telegram 开启，Slack 关闭）。使用 `channels.discord.commands.native: true|false|"auto"` 覆盖；`false` 会清除之前注册的命令。文本命令由 `commands.text` 控制，必须作为独立的 `/...` 消息发送。使用 `commands.useAccessGroups: false` 可跳过命令的访问组检查。
    - 完整命令列表 + 配置：[斜杠命令](/tools/slash-commands)
11. 可选服务器上下文历史：设置 `channels.discord.historyLimit`（默认 20，回退到 `messages.groupChat.historyLimit`）以在回复提及时包含最近 N 条服务器消息作为上下文。设置 `0` 禁用。
12. 表情反应：智能体可以通过 `discord` 工具触发表情反应（受 `channels.discord.actions.*` 控制）。
    - 表情反应移除语义：参见 [/tools/reactions](/tools/reactions)。
    - `discord` 工具仅在当前渠道是 Discord 时暴露。
13. 原生命令使用隔离的会话键（`agent:<agentId>:discord:slash:<userId>`）而不是共享的 `main` 会话。

注意：名称 → ID 解析使用服务器成员搜索，需要 Server Members Intent；如果机器人无法搜索成员，请使用 ID 或 `<@id>` 提及。
注意：Slug 为小写，空格替换为 `-`。频道名称的 slug 不包含前导 `#`。
注意：服务器上下文 `[from:]` 行包含 `author.tag` + `id`，便于进行可提及的回复。

## 配置写入

默认情况下，允许 Discord 写入由 `/config set|unset` 触发的配置更新（需要 `commands.config: true`）。

禁用方式：

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## 如何创建自己的机器人

这是在服务器（guild）频道（如 `#help`）中运行 OpenClaw 的"Discord 开发者门户"设置。

### 1）创建 Discord 应用 + 机器人用户

1. Discord 开发者门户 → **Applications** → **New Application**
2. 在你的应用中：
   - **Bot** → **Add Bot**
   - 复制 **Bot Token**（这是你放入 `DISCORD_BOT_TOKEN` 的内容）

### 2）启用 OpenClaw 需要的网关意图

Discord 会阻止"特权意图"，除非你明确启用它们。

在 **Bot** → **Privileged Gateway Intents** 中启用：

- **Message Content Intent**（在大多数服务器中读取消息文本所必需；没有它你会看到"Used disallowed intents"或机器人会连接但不响应消息）
- **Server Members Intent**（推荐；服务器中的某些成员/用户查找和允许列表匹配需要）

你通常**不需要** **Presence Intent**。

### 3）生成邀请 URL（OAuth2 URL Generator）

在你的应用中：**OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands`（原生命令所需）

**Bot Permissions**（最小基线）

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions（可选但推荐）
- ✅ Use External Emojis / Stickers（可选；仅当你需要时）

除非你在调试并完全信任机器人，否则避免使用 **Administrator**。

复制生成的 URL，打开它，选择你的服务器，然后安装机器人。

### 4）获取 ID（服务器/用户/频道）

Discord 到处使用数字 ID；OpenClaw 配置优先使用 ID。

1. Discord（桌面/网页）→ **用户设置** → **高级** → 启用 **开发者模式**
2. 右键点击：
   - 服务器名称 → **复制服务器 ID**（服务器 ID）
   - 频道（例如 `#help`）→ **复制频道 ID**
   - 你的用户 → **复制用户 ID**

### 5）配置 OpenClaw

#### 令牌

通过环境变量设置机器人令牌（服务器上推荐）：

- `DISCORD_BOT_TOKEN=...`

或通过配置：

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

多账户支持：使用 `channels.discord.accounts`，每个账户有自己的令牌和可选的 `name`。参见 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 了解通用模式。

#### 允许列表 + 频道路由

示例"单服务器，只允许我，只允许 #help"：

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
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

注意：

- `requireMention: true` 意味着机器人只在被提及时回复（推荐用于共享频道）。
- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）对于服务器消息也算作提及。
- 多智能体覆盖：在 `agents.list[].groupChat.mentionPatterns` 上设置每个智能体的模式。
- 如果存在 `channels`，任何未列出的频道默认被拒绝。
- 使用 `"*"` 频道条目在所有频道应用默认值；显式频道条目覆盖通配符。
- 话题继承父频道配置（允许列表、`requireMention`、Skills、提示词等），除非你显式添加话题频道 ID。
- 机器人发送的消息默认被忽略；设置 `channels.discord.allowBots=true` 允许它们（自己的消息仍被过滤）。
- 警告：如果你允许回复其他机器人（`channels.discord.allowBots=true`），请使用 `requireMention`、`channels.discord.guilds.*.channels.<id>.users` 允许列表和/或在 `AGENTS.md` 和 `SOUL.md` 中设置明确的防护措施来防止机器人之间的回复循环。

### 6）验证是否工作

1. 启动 Gateway 网关。
2. 在你的服务器频道中发送：`@Krill hello`（或你的机器人名称）。
3. 如果没有反应：查看下面的**故障排除**。

### 故障排除

- 首先：运行 `openclaw doctor` 和 `openclaw channels status --probe`（可操作的警告 + 快速审计）。
- **"Used disallowed intents"**：在开发者门户中启用 **Message Content Intent**（可能还需要 **Server Members Intent**），然后重启 Gateway 网关。
- **机器人连接但从不在服务器频道回复**：
  - 缺少 **Message Content Intent**，或
  - 机器人缺少频道权限（View/Send/Read History），或
  - 你的配置需要提及但你没有提及它，或
  - 你的服务器/频道允许列表拒绝了该频道/用户。
- **`requireMention: false` 但仍然没有回复**：
- `channels.discord.groupPolicy` 默认为 **allowlist**；将其设置为 `"open"` 或在 `channels.discord.guilds` 下添加服务器条目（可选择在 `channels.discord.guilds.<id>.channels` 下列出频道以进行限制）。
  - 如果你只设置了 `DISCORD_BOT_TOKEN` 而从未创建 `channels.discord` 部分，运行时会将 `groupPolicy` 默认为 `open`。添加 `channels.discord.groupPolicy`、`channels.defaults.groupPolicy` 或服务器/频道允许列表来锁定它。
- `requireMention` 必须位于 `channels.discord.guilds`（或特定频道）下。顶层的 `channels.discord.requireMention` 会被忽略。
- **权限审计**（`channels status --probe`）只检查数字频道 ID。如果你使用 slug/名称作为 `channels.discord.guilds.*.channels` 键，审计无法验证权限。
- **私信不工作**：`channels.discord.dm.enabled=false`、`channels.discord.dm.policy="disabled"`，或者你尚未被批准（`channels.discord.dm.policy="pairing"`）。
- **Discord 中的执行审批**：Discord 支持私信中执行审批的**按钮 UI**（允许一次 / 始终允许 / 拒绝）。`/approve <id> ...` 仅用于转发的审批，不会解析 Discord 的按钮提示。如果你看到 `❌ Failed to submit approval: Error: unknown approval id` 或 UI 从未出现，请检查：
  - 你的配置中有 `channels.discord.execApprovals.enabled: true`。
  - 你的 Discord 用户 ID 在 `channels.discord.execApprovals.approvers` 中列出（UI 仅发送给审批者）。
  - 使用私信提示中的按钮（**Allow once**、**Always allow**、**Deny**）。
  - 参见[执行审批](/tools/exec-approvals)和[斜杠命令](/tools/slash-commands)了解更广泛的审批和命令流程。

## 功能和限制

- 支持私信和服务器文字频道（话题被视为独立频道；不支持语音）。
- 打字指示器尽力发送；消息分块使用 `channels.discord.textChunkLimit`（默认 2000），并按行数分割长回复（`channels.discord.maxLinesPerMessage`，默认 17）。
- 可选换行分块：设置 `channels.discord.chunkMode="newline"` 以在空行（段落边界）处分割，然后再进行长度分块。
- 支持文件上传，最大 `channels.discord.mediaMaxMb`（默认 8 MB）。
- 默认服务器回复需要提及，以避免嘈杂的机器人。
- 当消息引用另一条消息时，会注入回复上下文（引用内容 + ID）。
- 原生回复线程**默认关闭**；使用 `channels.discord.replyToMode` 和回复标签启用。

## 重试策略

出站 Discord API 调用在速率限制（429）时使用 Discord `retry_after`（如果可用）进行重试，采用指数退避和抖动。通过 `channels.discord.retry` 配置。参见[重试策略](/concepts/retry)。

## 配置

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
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
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

确认表情反应通过 `messages.ackReaction` + `messages.ackReactionScope` 全局控制。使用 `messages.removeAckAfterReply` 在机器人回复后清除确认表情反应。

- `dm.enabled`：设置 `false` 忽略所有私信（默认 `true`）。
- `dm.policy`：私信访问控制（推荐 `pairing`）。`"open"` 需要 `dm.allowFrom=["*"]`。
- `dm.allowFrom`：私信允许列表（用户 ID 或名称）。用于 `dm.policy="allowlist"` 和 `dm.policy="open"` 验证。向导接受用户名，并在机器人可以搜索成员时将其解析为 ID。
- `dm.groupEnabled`：启用群组私信（默认 `false`）。
- `dm.groupChannels`：群组私信频道 ID 或 slug 的可选允许列表。
- `groupPolicy`：控制服务器频道处理（`open|disabled|allowlist`）；`allowlist` 需要频道允许列表。
- `guilds`：按服务器规则，以服务器 ID（首选）或 slug 为键。
- `guilds."*"`：当没有显式条目时应用的默认每服务器设置。
- `guilds.<id>.slug`：用于显示名称的可选友好 slug。
- `guilds.<id>.users`：可选的每服务器用户允许列表（ID 或名称）。
- `guilds.<id>.tools`：可选的每服务器工具策略覆盖（`allow`/`deny`/`alsoAllow`），在频道覆盖缺失时使用。
- `guilds.<id>.toolsBySender`：服务器级别的可选每发送者工具策略覆盖（在频道覆盖缺失时应用；支持 `"*"` 通配符）。
- `guilds.<id>.channels.<channel>.allow`：当 `groupPolicy="allowlist"` 时允许/拒绝频道。
- `guilds.<id>.channels.<channel>.requireMention`：频道的提及限制。
- `guilds.<id>.channels.<channel>.tools`：可选的每频道工具策略覆盖（`allow`/`deny`/`alsoAllow`）。
- `guilds.<id>.channels.<channel>.toolsBySender`：频道内的可选每发送者工具策略覆盖（支持 `"*"` 通配符）。
- `guilds.<id>.channels.<channel>.users`：可选的每频道用户允许列表。
- `guilds.<id>.channels.<channel>.skills`：Skills 过滤器（省略 = 所有 Skills，空 = 无）。
- `guilds.<id>.channels.<channel>.systemPrompt`：频道的额外系统提示词（与频道主题组合）。
- `guilds.<id>.channels.<channel>.enabled`：设置 `false` 禁用频道。
- `guilds.<id>.channels`：频道规则（键为频道 slug 或 ID）。
- `guilds.<id>.requireMention`：每服务器提及要求（可按频道覆盖）。
- `guilds.<id>.reactionNotifications`：表情反应系统事件模式（`off`、`own`、`all`、`allowlist`）。
- `textChunkLimit`：出站文本块大小（字符）。默认：2000。
- `chunkMode`：`length`（默认）仅在超过 `textChunkLimit` 时分割；`newline` 在空行（段落边界）处分割，然后再进行长度分块。
- `maxLinesPerMessage`：每条消息的软最大行数。默认：17。
- `mediaMaxMb`：限制保存到磁盘的入站媒体大小。
- `historyLimit`：回复提及时作为上下文包含的最近服务器消息数量（默认 20；回退到 `messages.groupChat.historyLimit`；`0` 禁用）。
- `dmHistoryLimit`：私信历史限制（用户轮次）。每用户覆盖：`dms["<user_id>"].historyLimit`。
- `retry`：出站 Discord API 调用的重试策略（attempts、minDelayMs、maxDelayMs、jitter）。
- `pluralkit`：解析 PluralKit 代理消息，使系统成员显示为不同的发送者。
- `actions`：每操作工具门控；省略允许所有（设置 `false` 禁用）。
  - `reactions`（涵盖表情反应 + 读取表情反应）
  - `stickers`、`emojiUploads`、`stickerUploads`、`polls`、`permissions`、`messages`、`threads`、`pins`、`search`
  - `memberInfo`、`roleInfo`、`channelInfo`、`voiceStatus`、`events`
  - `channels`（创建/编辑/删除频道 + 类别 + 权限）
  - `roles`（角色添加/移除，默认 `false`）
  - `moderation`（超时/踢出/封禁，默认 `false`）
- `execApprovals`：Discord 专用执行审批私信（按钮 UI）。支持 `enabled`、`approvers`、`agentFilter`、`sessionFilter`。

表情反应通知使用 `guilds.<id>.reactionNotifications`：

- `off`：无表情反应事件。
- `own`：机器人自己消息上的表情反应（默认）。
- `all`：所有消息上的所有表情反应。
- `allowlist`：来自 `guilds.<id>.users` 的用户在所有消息上的表情反应（空列表禁用）。

### PluralKit（PK）支持

启用 PK 查找，以便代理消息解析到底层系统 + 成员。启用后，OpenClaw 使用成员身份进行允许列表匹配，并将发送者标记为 `Member (PK:System)` 以避免意外的 Discord 提及。

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // 可选；私有系统需要
      },
    },
  },
}
```

允许列表注意事项（启用 PK 时）：

- 在 `dm.allowFrom`、`guilds.<id>.users` 或每频道 `users` 中使用 `pk:<memberId>`。
- 成员显示名称也按名称/slug 匹配。
- 查找使用**原始** Discord 消息 ID（代理前的消息），因此 PK API 只在其 30 分钟窗口内解析它。
- 如果 PK 查找失败（例如，没有令牌的私有系统），代理消息会被视为机器人消息并被丢弃，除非 `channels.discord.allowBots=true`。

### 工具操作默认值

| 操作组         | 默认 | 说明                                |
| -------------- | ---- | ----------------------------------- |
| reactions      | 启用 | 表情反应 + 列出表情反应 + emojiList |
| stickers       | 启用 | 发送贴纸                            |
| emojiUploads   | 启用 | 上传表情                            |
| stickerUploads | 启用 | 上传贴纸                            |
| polls          | 启用 | 创建投票                            |
| permissions    | 启用 | 频道权限快照                        |
| messages       | 启用 | 读取/发送/编辑/删除                 |
| threads        | 启用 | 创建/列出/回复                      |
| pins           | 启用 | 置顶/取消置顶/列出                  |
| search         | 启用 | 消息搜索（预览功能）                |
| memberInfo     | 启用 | 成员信息                            |
| roleInfo       | 启用 | 角色列表                            |
| channelInfo    | 启用 | 频道信息 + 列表                     |
| channels       | 启用 | 频道/类别管理                       |
| voiceStatus    | 启用 | 语音状态查询                        |
| events         | 启用 | 列出/创建预定事件                   |
| roles          | 禁用 | 角色添加/移除                       |
| moderation     | 禁用 | 超时/踢出/封禁                      |

- `replyToMode`：`off`（默认）、`first` 或 `all`。仅在模型包含回复标签时适用。

## 回复标签

要请求线程回复，模型可以在其输出中包含一个标签：

- `[[reply_to_current]]` — 回复触发的 Discord 消息。
- `[[reply_to:<id>]]` — 回复上下文/历史中的特定消息 ID。当前消息 ID 作为 `[message_id: …]` 附加到提示词；历史条目已包含 ID。

行为由 `channels.discord.replyToMode` 控制：

- `off`：忽略标签。
- `first`：只有第一个出站块/附件是回复。
- `all`：每个出站块/附件都是回复。

允许列表匹配注意事项：

- `allowFrom`/`users`/`groupChannels` 接受 ID、名称、标签或像 `<@id>` 这样的提及。
- 支持 `discord:`/`user:`（用户）和 `channel:`（群组私信）等前缀。
- 使用 `*` 允许任何发送者/频道。
- 当存在 `guilds.<id>.channels` 时，未列出的频道默认被拒绝。
- 当省略 `guilds.<id>.channels` 时，允许列表中服务器的所有频道都被允许。
- 要**不允许任何频道**，设置 `channels.discord.groupPolicy: "disabled"`（或保持空允许列表）。
- 配置向导接受 `Guild/Channel` 名称（公开 + 私有）并在可能时将其解析为 ID。
- 启动时，OpenClaw 将允许列表中的频道/用户名称解析为 ID（当机器人可以搜索成员时）并记录映射；未解析的条目保持原样。

原生命令注意事项：

- 注册的命令镜像 OpenClaw 的聊天命令。
- 原生命令遵循与私信/服务器消息相同的允许列表（`channels.discord.dm.allowFrom`、`channels.discord.guilds`、每频道规则）。
- 斜杠命令可能在 Discord UI 中对未在允许列表中的用户仍然可见；OpenClaw 在执行时强制执行允许列表并回复"未授权"。

## 工具操作

智能体可以使用以下操作调用 `discord`：

- `react` / `reactions`（添加或列出表情反应）
- `sticker`、`poll`、`permissions`
- `readMessages`、`sendMessage`、`editMessage`、`deleteMessage`
- 读取/搜索/置顶工具负载包含规范化的 `timestampMs`（UTC 纪元毫秒）和 `timestampUtc` 以及原始 Discord `timestamp`。
- `threadCreate`、`threadList`、`threadReply`
- `pinMessage`、`unpinMessage`、`listPins`
- `searchMessages`、`memberInfo`、`roleInfo`、`roleAdd`、`roleRemove`、`emojiList`
- `channelInfo`、`channelList`、`voiceStatus`、`eventList`、`eventCreate`
- `timeout`、`kick`、`ban`

Discord 消息 ID 在注入的上下文中显示（`[discord message id: …]` 和历史行），以便智能体可以定位它们。
表情可以是 unicode（例如 `✅`）或自定义表情语法如 `<:party_blob:1234567890>`。

## 安全与运维

- 像对待密码一样对待机器人令牌；在受监督的主机上优先使用 `DISCORD_BOT_TOKEN` 环境变量，或锁定配置文件权限。
- 只授予机器人所需的权限（通常是读取/发送消息）。
- 如果机器人卡住或受到速率限制，在确认没有其他进程拥有 Discord 会话后重启 Gateway 网关（`openclaw gateway --force`）。
