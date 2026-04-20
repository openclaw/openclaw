---
summary: "Discord 机器人支持状态、功能和配置"
read_when:
  - 处理 Discord 通道功能

title: "Discord"
---

# Discord (Bot API)

状态：通过官方 Discord 网关为私信和公会频道做好准备。

<CardGroup cols={3}>
  <Card title="配对" icon="link" href="/channels/pairing">
    Discord 私信默认使用配对模式。
  </Card>
  <Card title="斜杠命令" icon="terminal" href="/tools/slash-commands">
    原生命令行为和命令目录。
  </Card>
  <Card title="通道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨通道诊断和修复流程。
  </Card>
</CardGroup>

## 快速设置

你需要创建一个新的应用程序和机器人，将机器人添加到你的服务器，并将其与 OpenClaw 配对。我们建议将你的机器人添加到你自己的私有服务器。如果你还没有服务器，请[先创建一个](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server)（选择 **Create My Own > For me and my friends**）。

<Steps>
  <Step title="创建 Discord 应用程序和机器人">
    前往 [Discord 开发者门户](https://discord.com/developers/applications) 并点击 **New Application**。将其命名为 "OpenClaw" 之类的名称。

    点击侧边栏上的 **Bot**。将 **Username** 设置为你给 OpenClaw 代理的名称。

  </Step>

  <Step title="启用特权意图">
    仍然在 **Bot** 页面上，向下滚动到 **Privileged Gateway Intents** 并启用：

    - **Message Content Intent**（必需）
    - **Server Members Intent**（推荐；角色允许列表和名称到 ID 匹配需要）
    - **Presence Intent**（可选；仅在需要状态更新时需要）

  </Step>

  <Step title="复制你的机器人令牌">
    在 **Bot** 页面上向上滚动并点击 **Reset Token**。

    <Note>
    尽管名称如此，这会生成你的第一个令牌 — 没有任何东西被"重置"。
    </Note>

    复制令牌并保存在某个地方。这是你的 **Bot Token**，你很快就会需要它。

  </Step>

  <Step title="生成邀请 URL 并将机器人添加到你的服务器">
    点击侧边栏上的 **OAuth2**。你将生成一个带有正确权限的邀请 URL，以将机器人添加到你的服务器。

    向下滚动到 **OAuth2 URL Generator** 并启用：

    - `bot`
    - `applications.commands`

    下方会出现一个 **Bot Permissions** 部分。启用：

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions（可选）

    复制底部生成的 URL，将其粘贴到你的浏览器中，选择你的服务器，然后点击 **Continue** 连接。你现在应该在 Discord 服务器中看到你的机器人。

  </Step>

  <Step title="启用开发者模式并收集你的 ID">
    回到 Discord 应用程序，你需要启用开发者模式，以便你可以复制内部 ID。

    1. 点击 **User Settings**（头像旁边的齿轮图标）→ **Advanced** → 打开 **Developer Mode**
    2. 右键点击侧边栏中的 **服务器图标** → **Copy Server ID**
    3. 右键点击你**自己的头像** → **Copy User ID**

    将你的 **Server ID** 和 **User ID** 与 Bot Token 一起保存 — 你将在下一步中将这三个都发送给 OpenClaw。

  </Step>

  <Step title="允许来自服务器成员的私信">
    为了配对工作，Discord 需要允许你的机器人向你发送私信。右键点击你的 **服务器图标** → **Privacy Settings** → 打开 **Direct Messages**。

    这允许服务器成员（包括机器人）向你发送私信。如果你想使用 Discord 私信与 OpenClaw，请保持此选项启用。如果你只计划使用公会频道，可以在配对后禁用私信。

  </Step>

  <Step title="安全设置你的机器人令牌（不要在聊天中发送）">
    你的 Discord 机器人令牌是一个秘密（就像密码一样）。在向你的代理发送消息之前，在运行 OpenClaw 的机器上设置它。

```bash
export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN --dry-run
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN
openclaw config set channels.discord.enabled true --strict-json
openclaw gateway
```

    如果 OpenClaw 已经作为后台服务运行，请通过 OpenClaw Mac 应用程序或通过停止并重新启动 `openclaw gateway run` 进程来重新启动它。

  </Step>

  <Step title="配置 OpenClaw 并配对">

    <Tabs>
      <Tab title="询问你的代理">
        在任何现有通道（例如 Telegram）上与你的 OpenClaw 代理聊天并告诉它。如果 Discord 是你的第一个通道，请改用 CLI / 配置选项卡。

        > "我已经在配置中设置了我的 Discord 机器人令牌。请使用用户 ID `<user_id>` 和服务器 ID `<server_id>` 完成 Discord 设置。"
      </Tab>
      <Tab title="CLI / 配置">
        如果你更喜欢基于文件的配置，请设置：

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: {
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      },
    },
  },
}
```

        默认账户的环境回退：

```bash
DISCORD_BOT_TOKEN=...
```

        支持纯文本 `token` 值。`channels.discord.token` 也支持跨环境/文件/执行提供商的 SecretRef 值。请参阅 [Secrets Management](/gateway/secrets)。

      </Tab>
    </Tabs>

  </Step>

  <Step title="批准首次私信配对">
    等待网关运行，然后在 Discord 中向你的机器人发送私信。它会用配对代码回复。

    <Tabs>
      <Tab title="询问你的代理">
        在你现有的通道上向你的代理发送配对代码：

        > "批准这个 Discord 配对代码：`<CODE>`"
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    配对代码在 1 小时后过期。

    你现在应该能够通过私信在 Discord 中与你的代理聊天。

  </Step>
</Steps>

<Note>
令牌解析是账户感知的。配置令牌值优先于环境回退。`DISCORD_BOT_TOKEN` 仅用于默认账户。
对于高级出站调用（消息工具/通道操作），该调用使用显式的每个调用 `token`。这适用于发送和读取/探测式操作（例如读取/搜索/获取/线程/引脚/权限）。账户策略/重试设置仍然来自活动运行时快照中的选定账户。
</Note>

## 推荐：设置公会工作区

一旦私信正常工作，你可以将你的 Discord 服务器设置为完整工作区，其中每个通道都有自己的代理会话和自己的上下文。这推荐用于只有你和你的机器人的私有服务器。

<Steps>
  <Step title="将你的服务器添加到公会允许列表">
    这使你的代理能够在你的服务器上的任何通道中响应，而不仅仅是私信。

    <Tabs>
      <Tab title="询问你的代理">
        > "将我的 Discord 服务器 ID `<server_id>` 添加到公会允许列表"
      </Tab>
      <Tab title="配置">

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="允许无需 @提及的响应">
    默认情况下，你的代理只在 @提及时才会在公会频道中响应。对于私有服务器，你可能希望它响应每条消息。

    <Tabs>
      <Tab title="询问你的代理">
        > "允许我的代理在这个服务器上响应，无需被 @提及"
      </Tab>
      <Tab title="配置">
        在你的公会配置中设置 `requireMention: false`：

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: false,
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="为公会频道中的记忆做计划">
    默认情况下，长期记忆（MEMORY.md）仅在私信会话中加载。公会频道不会自动加载 MEMORY.md。

    <Tabs>
      <Tab title="询问你的代理">
        > "当我在 Discord 频道中提问时，如果你需要来自 MEMORY.md 的长期上下文，请使用 memory_search 或 memory_get。"
      </Tab>
      <Tab title="手动">
        如果你需要在每个频道中共享上下文，将稳定的指令放在 `AGENTS.md` 或 `USER.md` 中（它们会为每个会话注入）。将长期笔记保存在 `MEMORY.md` 中，并通过记忆工具按需访问它们。
      </Tab>
    </Tabs>

  </Step>
</Steps>

现在在你的 Discord 服务器上创建一些频道并开始聊天。你的代理可以看到频道名称，每个频道都有自己的隔离会话 — 所以你可以设置 `#coding`、`#home`、`#research` 或任何适合你工作流程的频道。

## 运行时模型

- 网关拥有 Discord 连接。
- 回复路由是确定性的：Discord 入站回复回 Discord。
- 默认情况下（`session.dmScope=main`），直接聊天共享代理主会话（`agent:main:main`）。
- 公会频道是隔离的会话键（`agent:<agentId>:discord:channel:<channelId>`）。
- 群组私信默认被忽略（`channels.discord.dm.groupEnabled=false`）。
- 原生斜杠命令在隔离的命令会话中运行（`agent:<agentId>:discord:slash:<userId>`），同时仍然将 `CommandTargetSessionKey` 携带到路由的对话会话。

## 论坛频道

Discord 论坛和媒体频道只接受线程帖子。OpenClaw 支持两种创建它们的方式：

- 向论坛父级（`channel:<forumId>`）发送消息以自动创建线程。线程标题使用消息的第一行非空行。
- 使用 `openclaw message thread create` 直接创建线程。不要为论坛频道传递 `--message-id`。

示例：发送到论坛父级以创建线程

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "Topic title\nBody of the post"
```

示例：显式创建论坛线程

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "Topic title" --message "Body of the post"
```

论坛父级不接受 Discord 组件。如果你需要组件，发送到线程本身（`channel:<threadId>`）。

## 交互式组件

OpenClaw 支持用于代理消息的 Discord 组件 v2 容器。使用带有 `components` 有效负载的消息工具。交互结果作为正常的入站消息路由回代理，并遵循现有的 Discord `replyToMode` 设置。

支持的块：

- `text`、`section`、`separator`、`actions`、`media-gallery`、`file`
- 操作行最多允许 5 个按钮或单个选择菜单
- 选择类型：`string`、`user`、`role`、`mentionable`、`channel`

默认情况下，组件是单次使用的。设置 `components.reusable=true` 以允许多次使用按钮、选择和表单，直到它们过期。

要限制谁可以点击按钮，请在该按钮上设置 `allowedUsers`（Discord 用户 ID、标签或 `*`）。配置后，不匹配的用户会收到短暂的拒绝。

`/model` 和 `/models` 斜杠命令打开一个交互式模型选择器，带有提供商和模型下拉菜单以及提交步骤。选择器回复是短暂的，只有调用用户可以使用它。

文件附件：

- `file` 块必须指向附件引用（`attachment://<filename>`）
- 通过 `media`/`path`/`filePath` 提供附件（单个文件）；使用 `media-gallery` 用于多个文件
- 使用 `filename` 在应与附件引用匹配时覆盖上传名称

模态表单：

- 添加最多 5 个字段的 `components.modal`
- 字段类型：`text`、`checkbox`、`radio`、`select`、`role-select`、`user-select`
- OpenClaw 自动添加触发按钮

示例：

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## 访问控制和路由

<Tabs>
  <Tab title="私信政策">
    `channels.discord.dmPolicy` 控制私信访问（旧版：`channels.discord.dm.policy`）：

    - `pairing`（默认）
    - `allowlist`
    - `open`（需要 `channels.discord.allowFrom` 包含 `"*"`；旧版：`channels.discord.dm.allowFrom`）
    - `disabled`

    如果私信政策不是开放的，未知用户会被阻止（或在 `pairing` 模式下提示配对）。

    多账户优先级：

    - `channels.discord.accounts.default.allowFrom` 仅适用于 `default` 账户。
    - 命名账户在未设置自己的 `allowFrom` 时继承 `channels.discord.allowFrom`。
    - 命名账户不继承 `channels.discord.accounts.default.allowFrom`。

    用于传递的私信目标格式：

    - `user:<id>`
    - `<@id>` 提及

    纯数字 ID 是模糊的，除非提供了明确的用户/通道目标类型，否则会被拒绝。

  </Tab>

  <Tab title="公会政策">
    公会处理由 `channels.discord.groupPolicy` 控制：

    - `open`
    - `allowlist`
    - `disabled`

    当 `channels.discord` 存在时，安全基线是 `allowlist`。

    `allowlist` 行为：

    - 公会必须匹配 `channels.discord.guilds`（首选 `id`，接受 slug）
    - 可选发送者允许列表：`users`（推荐稳定 ID）和 `roles`（仅角色 ID）；如果配置了任一，发送者在匹配 `users` 或 `roles` 时被允许
    - 默认禁用直接名称/标签匹配；仅作为紧急兼容性模式启用 `channels.discord.dangerouslyAllowNameMatching: true`
    - `users` 支持名称/标签，但 ID 更安全；`openclaw security audit` 会在使用名称/标签条目时发出警告
    - 如果公会配置了 `channels`，则拒绝未列出的频道
    - 如果公会没有 `channels` 块，则允许该允许列表公会中的所有频道

    示例：

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          ignoreOtherMentions: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    如果你只设置 `DISCORD_BOT_TOKEN` 而不创建 `channels.discord` 块，运行时回退是 `groupPolicy="allowlist"`（日志中有警告），即使 `channels.defaults.groupPolicy` 是 `open`。

  </Tab>

  <Tab title="提及和群组私信">
    公会消息默认受提及限制。

    提及检测包括：

    - 显式机器人提及
    - 配置的提及模式（`agents.list[].groupChat.mentionPatterns`，回退 `messages.groupChat.mentionPatterns`）
    - 支持情况下的隐式回复机器人行为

    `requireMention` 在每个公会/频道（`channels.discord.guilds...`）上配置。
    `ignoreOtherMentions` 可选地丢弃提及其他用户/角色但不提及机器人的消息（不包括 @everyone/@here）。

    群组私信：

    - 默认：忽略（`dm.groupEnabled=false`）
    - 可选通过 `dm.groupChannels` 允许列表（频道 ID 或 slug）

  </Tab>
</Tabs>

### 基于角色的代理路由

使用 `bindings[].match.roles` 按角色 ID 将 Discord 公会成员路由到不同的代理。基于角色的绑定仅接受角色 ID，并在对等或父对等绑定之后、仅公会绑定之前评估。如果绑定还设置了其他匹配字段（例如 `peer` + `guildId` + `roles`），则必须匹配所有配置的字段。

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## 开发者门户设置

<AccordionGroup>
  <Accordion title="创建应用和机器人">

    1. Discord 开发者门户 -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. 复制机器人令牌

  </Accordion>

  <Accordion title="特权意图">
    在 **Bot -> Privileged Gateway Intents** 中，启用：

    - Message Content Intent
    - Server Members Intent（推荐）

    状态意图是可选的，仅在你想要接收状态更新时才需要。设置机器人状态（`setPresence`）不需要为成员启用状态更新。

  </Accordion>

  <Accordion title="OAuth 作用域和基线权限">
    OAuth URL 生成器：

    - 作用域：`bot`、`applications.commands`

    典型的基线权限：

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions（可选）

    除非明确需要，否则避免使用 `Administrator`。

  </Accordion>

  <Accordion title="复制 ID">
    启用 Discord 开发者模式，然后复制：

    - 服务器 ID
    - 频道 ID
    - 用户 ID

    在 OpenClaw 配置中首选数字 ID，以获得可靠的审计和探测。

  </Accordion>
</AccordionGroup>

## 原生命令和命令认证

- `commands.native` 默认值为 `"auto"`，并为 Discord 启用。
- 每频道覆盖：`channels.discord.commands.native`。
- `commands.native=false` 显式清除之前注册的 Discord 原生命令。
- 原生命令认证使用与正常消息处理相同的 Discord 允许列表/政策。
- 命令可能仍然在 Discord UI 中对未授权的用户可见；执行仍然强制执行 OpenClaw 认证并返回"未授权"。

有关命令目录和行为，请参阅 [Slash commands](/tools/slash-commands)。

默认斜杠命令设置：

- `ephemeral: true`

## 功能详情

<AccordionGroup>
  <Accordion title="回复标签和原生回复">
    Discord 支持代理输出中的回复标签：

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    由 `channels.discord.replyToMode` 控制：

    - `off`（默认）
    - `first`
    - `all`
    - `batched`

    注意：`off` 禁用隐式回复线程。显式 `[[reply_to_*]]` 标签仍然被尊重。
    `first` 始终将隐式原生回复引用附加到该轮的第一条 Discord 出站消息。
    `batched` 仅在入站轮是多个消息的去抖动批处理时才附加 Discord 的隐式原生回复引用。当你主要希望对模糊的突发聊天使用原生回复，而不是对每条单消息轮使用时，这很有用。

    消息 ID 在上下文/历史记录中显示，因此代理可以针对特定消息。

  </Accordion>

  <Accordion title="实时流预览">
    OpenClaw 可以通过发送临时消息并在文本到达时编辑它来流式传输草稿回复。

    - `channels.discord.streaming` 控制预览流式传输（`off` | `partial` | `block` | `progress`，默认：`off`）。
    - 默认保持 `off`，因为 Discord 预览编辑可能会快速达到速率限制，尤其是当多个机器人或网关共享相同的账户或公会流量时。
    - `progress` 被接受以保持跨通道一致性，并在 Discord 上映射到 `partial`。
    - `channels.discord.streamMode` 是旧版别名，会自动迁移。
    - `partial` 随着令牌到达而编辑单个预览消息。
    - `block` 发出草稿大小的块（使用 `draftChunk` 调整大小和断点）。

    示例：

```json5
{
  channels: {
    discord: {
      streaming: "partial",
    },
  },
}
```

    `block` 模式分块默认值（限制为 `channels.discord.textChunkLimit`）：

```json5
{
  channels: {
    discord: {
      streaming: "block",
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
      },
    },
  },
}
```

    预览流式传输仅文本；媒体回复回退到正常传递。

    注意：预览流式传输与块流式传输分开。当为 Discord 显式启用块流式传输时，OpenClaw 会跳过预览流以避免双重流式传输。

  </Accordion>

  <Accordion title="历史、上下文和线程行为">
    公会历史上下文：

    - `channels.discord.historyLimit` 默认 `20`
    - 回退：`messages.groupChat.historyLimit`
    - `0` 禁用

    私信历史控制：

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    线程行为：

    - Discord 线程作为频道会话路由
    - 父线程元数据可用于父会话链接
    - 线程配置继承父频道配置，除非存在线程特定条目

    频道主题作为**不受信任**的上下文注入（不作为系统提示）。
    回复和引用消息上下文当前保持原样接收。
    Discord 允许列表主要控制谁可以触发代理，而不是完整的补充上下文编辑边界。

  </Accordion>

  <Accordion title="子代理的线程绑定会话">
    Discord 可以将线程绑定到会话目标，以便该线程中的后续消息保持路由到同一个会话（包括子代理会话）。

    命令：

    - `/focus <target>` 将当前/新线程绑定到子代理/会话目标
    - `/unfocus` 移除当前线程绑定
    - `/agents` 显示活动运行和绑定状态
    - `/session idle <duration|off>` 检查/更新聚焦绑定的非活动自动取消聚焦
    - `/session max-age <duration|off>` 检查/更新聚焦绑定的硬最大年龄

    配置：

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSubagentSessions: false, // 选择加入
      },
    },
  },
}
```

    注意：

    - `session.threadBindings.*` 设置全局默认值。
    - `channels.discord.threadBindings.*` 覆盖 Discord 行为。
    - `spawnSubagentSessions` 必须为 true 才能为 `sessions_spawn({ thread: true })` 自动创建/绑定线程。
    - `spawnAcpSessions` 必须为 true 才能为 ACP (`/acp spawn ... --thread ...` 或 `sessions_spawn({ runtime: "acp", thread: true })`) 自动创建/绑定线程。
    - 如果为账户禁用线程绑定，则 `/focus` 和相关线程绑定操作不可用。

    请参阅 [Sub-agents](/tools/subagents)、[ACP Agents](/tools/acp-agents) 和 [Configuration Reference](/gateway/configuration-reference)。

  </Accordion>

  <Accordion title="持久 ACP 频道绑定">
    对于稳定的"始终开启"ACP 工作区，配置针对 Discord 对话的顶级类型化 ACP 绑定。

    配置路径：

    - `bindings[]` 带有 `type: "acp"` 和 `match.channel: "discord"`

    示例：

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": {
              requireMention: false,
            },
          },
        },
      },
    },
  },
}
```

    注意：

    - `/acp spawn codex --bind here` 绑定当前 Discord 频道或线程，并保持将来的消息路由到同一个 ACP 会话。
    - 这仍然可能意味着"启动一个新的 Codex ACP 会话"，但它本身不会创建新的 Discord 线程。现有频道保持为聊天界面。
    - Codex 可能仍然在自己的 `cwd` 或磁盘上的后端工作区中运行。该工作区是运行时状态，而不是 Discord 线程。
    - 线程消息可以继承父频道 ACP 绑定。
    - 在绑定的频道或线程中，`/new` 和 `/reset` 在原地重置同一个 ACP 会话。
    - 临时线程绑定仍然有效，并且可以在活动时覆盖目标解析。
    - `spawnAcpSessions` 仅在 OpenClaw 需要通过 `--thread auto|here` 创建/绑定子线程时才需要。对于当前频道中的 `/acp spawn ... --bind here` 不需要。

    有关绑定行为详细信息，请参阅 [ACP Agents](/tools/acp-agents)。

  </Accordion>

  <Accordion title="反应通知">
    每公会反应通知模式：

    - `off`
    - `own`（默认）
    - `all`
    - `allowlist`（使用 `guilds.<id>.users`）

    反应事件被转换为系统事件并附加到路由的 Discord 会话。

  </Accordion>

  <Accordion title="确认反应">
    `ackReaction` 在 OpenClaw 处理入站消息时发送确认表情符号。

    解析顺序：

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - 代理身份表情回退（`agents.list[].identity.emoji`，否则 "👀"）

    注意：

    - Discord 接受 unicode 表情或自定义表情名称。
    - 使用 `""` 为频道或账户禁用反应。

  </Accordion>

  <Accordion title="配置写入">
    通道发起的配置写入默认启用。

    这影响 `/config set|unset` 流程（当命令功能启用时）。

    禁用：

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="网关代理">
    通过 `channels.discord.proxy` 将 Discord 网关 WebSocket 流量和启动 REST 查找（应用程序 ID + 允许列表解析）路由通过 HTTP(S) 代理。

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    每账户覆盖：

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="PluralKit 支持">
    启用 PluralKit 解析以将代理消息映射到系统成员身份：

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

    注意：

    - 允许列表可以使用 `pk:<memberId>`
    - 成员显示名称仅在 `channels.discord.dangerouslyAllowNameMatching: true` 时通过名称/slug 匹配
    - 查找使用原始消息 ID 并受时间窗口约束
    - 如果查找失败，代理消息被视为机器人消息并被丢弃，除非 `allowBots=true`

  </Accordion>

  <Accordion title="状态配置">
    当你设置状态或活动字段，或启用自动状态时，会应用状态更新。

    仅状态示例：

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    活动示例（自定义状态是默认活动类型）：

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    流媒体示例：

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    活动类型映射：

    - 0: Playing
    - 1: Streaming（需要 `activityUrl`）
    - 2: Listening
    - 3: Watching
    - 4: Custom（使用活动文本作为状态状态；表情是可选的）
    - 5: Competing

    自动状态示例（运行时健康信号）：

```json5
{
  channels: {
    discord: {
      autoPresence: {
        enabled: true,
        intervalMs: 30000,
        minUpdateIntervalMs: 15000,
        exhaustedText: "token exhausted",
      },
    },
  },
}
```

    自动状态将运行时可用性映射到 Discord 状态：健康 => 在线，降级或未知 => 空闲，耗尽或不可用 => 请勿打扰。可选文本覆盖：

    - `autoPresence.healthyText`
    - `autoPresence.degradedText`
    - `autoPresence.exhaustedText`（支持 `{reason}` 占位符）

  </Accordion>

  <Accordion title="Discord 中的批准">
    Discord 支持私信中基于按钮的批准处理，并可以选择在原始频道中发布批准提示。

    配置路径：

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`（可选；可能时回退到 `commands.ownerAllowFrom`）
    - `channels.discord.execApprovals.target`（`dm` | `channel` | `both`，默认：`dm`）
    - `agentFilter`、`sessionFilter`、`cleanupAfterResolve`

    当 `enabled` 未设置或为 `"auto"` 且至少可以解析一个审批者（从 `execApprovals.approvers` 或 `commands.ownerAllowFrom`）时，Discord 自动启用原生执行批准。Discord 不会从频道 `allowFrom`、旧版 `dm.allowFrom` 或直接消息 `defaultTo` 推断执行审批者。设置 `enabled: false` 以明确禁用 Discord 作为原生批准客户端。

    当 `target` 为 `channel` 或 `both` 时，批准提示在频道中可见。只有解析的审批者可以使用按钮；其他用户会收到短暂的拒绝。批准提示包含命令文本，因此只在受信任的频道中启用频道传递。如果无法从会话密钥派生频道 ID，OpenClaw 会回退到私信传递。

    Discord 还渲染其他聊天频道使用的共享批准按钮。原生 Discord 适配器主要添加审批者私信路由和频道扇出。
    当这些按钮存在时，它们是主要的批准 UX；OpenClaw
    应该只在工具结果说聊天批准不可用或手动批准是唯一路径时才包含手动 `/approve` 命令。

    此处理程序的网关认证使用与其他网关客户端相同的共享凭证解析契约：

    - 环境优先本地认证（`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` 然后 `gateway.auth.*`）
    - 在本地模式下，`gateway.remote.*` 仅在 `gateway.auth.*` 未设置时可用作回退；配置但未解析的本地 SecretRefs 失败关闭
    - 通过 `gateway.remote.*` 的远程模式支持（如适用）
    - URL 覆盖是覆盖安全的：CLI 覆盖不重用隐式凭证，环境覆盖仅使用环境凭证

    批准解析行为：

    - 前缀为 `plugin:` 的 ID 通过 `plugin.approval.resolve` 解析。
    - 其他 ID 通过 `exec.approval.resolve` 解析。
    - Discord 在此处不进行额外的 exec 到插件回退跳转；id
      前缀决定它调用哪个网关方法。

    执行批准默认在 30 分钟后过期。如果批准因未知批准 ID 而失败，请验证审批者解析、功能启用以及传递的批准 ID 类型是否与待处理请求匹配。

    相关文档：[Exec approvals](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## 工具和操作门

Discord 消息操作包括消息传递、频道管理、审核、状态和元数据操作。

核心示例：

- 消息传递：`sendMessage`、`readMessages`、`editMessage`、`deleteMessage`、`threadReply`
- 反应：`react`、`reactions`、`emojiList`
- 审核：`timeout`、`kick`、`ban`
- 状态：`setPresence`

`event-create` 操作接受可选的 `image` 参数（URL 或本地文件路径）以设置预定事件封面图像。

操作门位于 `channels.discord.actions.*` 下。

默认门行为：

| 操作组                                                                                                                                                             | 默认值  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | 启用  |
| roles                                                                                                                                                                    | 禁用 |
| moderation                                                                                                                                                               | 禁用 |
| presence                                                                                                                                                                 | 禁用 |

## 组件 v2 UI

OpenClaw 使用 Discord 组件 v2 进行执行批准和跨上下文标记。Discord 消息操作也可以接受 `components` 用于自定义 UI（高级；需要通过 discord 工具构造组件有效负载），而旧版 `embeds` 仍然可用但不推荐。

- `channels.discord.ui.components.accentColor` 设置 Discord 组件容器使用的强调色（十六进制）。
- 使用 `channels.discord.accounts.<id>.ui.components.accentColor` 为每个账户设置。
- 当组件 v2 存在时，`embeds` 被忽略。

示例：

```json5
{
  channels: {
    discord: {
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
    },
  },
}
```

## 语音频道

OpenClaw 可以加入 Discord 语音频道进行实时、连续的对话。这与语音消息附件分开。

要求：

- 启用原生命令（`commands.native` 或 `channels.discord.commands.native`）。
- 配置 `channels.discord.voice`。
- 机器人在目标语音频道中需要 Connect + Speak 权限。

使用 Discord 专用的原生命令 `/vc join|leave|status` 控制会话。该命令使用账户默认代理，并遵循与其他 Discord 命令相同的允许列表和组策略规则。

自动加入示例：

```json5
{
  channels: {
    discord: {
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
    },
  },
}
```

注意：

- `voice.tts` 仅覆盖语音播放的 `messages.tts`。
- 语音转录轮从 Discord `allowFrom`（或 `dm.allowFrom`）派生所有者状态；非所有者发言者无法访问所有者专用工具（例如 `gateway` 和 `cron`）。
- 语音默认启用；设置 `channels.discord.voice.enabled=false` 以禁用它。
- `voice.daveEncryption` 和 `voice.decryptionFailureTolerance` 传递给 `@discordjs/voice` 加入选项。
- 如果未设置，`@discordjs/voice` 默认值为 `daveEncryption=true` 和 `decryptionFailureTolerance=24`。
- OpenClaw 还监视接收解密失败，并在短窗口内重复失败后通过离开/重新加入语音频道自动恢复。
- 如果接收日志反复显示 `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`，这可能是在 [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) 中跟踪的上游 `@discordjs/voice` 接收错误。

## 语音消息

Discord 语音消息显示波形预览，需要 OGG/Opus 音频和元数据。OpenClaw 自动生成波形，但它需要 `ffmpeg` 和 `ffprobe` 在网关主机上可用，以检查和转换音频文件。

要求和约束：

- 提供**本地文件路径**（URL 被拒绝）。
- 省略文本内容（Discord 不允许在同一有效负载中同时包含文本和语音消息）。
- 接受任何音频格式；OpenClaw 在需要时转换为 OGG/Opus。

示例：

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## 故障排除

<AccordionGroup>
  <Accordion title="使用了不允许的意图或机器人看不到公会消息">

    - 启用 Message Content Intent
    - 当你依赖用户/成员解析时启用 Server Members Intent
    - 更改意图后重启网关

  </Accordion>

  <Accordion title="公会消息意外被阻止">

    - 验证 `groupPolicy`
    - 验证 `channels.discord.guilds` 下的公会允许列表
    - 如果存在公会 `channels` 映射，仅允许列出的频道
    - 验证 `requireMention` 行为和提及模式

    有用的检查：

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="require mention false 但仍然被阻止">
    常见原因：

    - `groupPolicy="allowlist"` 没有匹配的公会/频道允许列表
    - `requireMention` 配置在错误的位置（必须在 `channels.discord.guilds` 或频道条目下）
    - 发送者被公会/频道 `users` 允许列表阻止

  </Accordion>

  <Accordion title="长时间运行的处理程序超时或重复回复">

    典型日志：

    - `Listener DiscordMessageListener timed out after 30000ms for event MESSAGE_CREATE`
    - `Slow listener detected ...`
    - `discord inbound worker timed out after ...`

    监听器预算旋钮：

    - 单账户：`channels.discord.eventQueue.listenerTimeout`
    - 多账户：`channels.discord.accounts.<accountId>.eventQueue.listenerTimeout`

    工作线程运行超时旋钮：

    - 单账户：`channels.discord.inboundWorker.runTimeoutMs`
    - 多账户：`channels.discord.accounts.<accountId>.inboundWorker.runTimeoutMs`
    - 默认：`1800000`（30 分钟）；设置 `0` 禁用

    推荐基线：

```json5
{
  channels: {
    discord: {
      accounts: {
        default: {
          eventQueue: {
            listenerTimeout: 120000,
          },
          inboundWorker: {
            runTimeoutMs: 1800000,
          },
        },
      },
    },
  },
}
```

    使用 `eventQueue.listenerTimeout` 用于缓慢的监听器设置，使用 `inboundWorker.runTimeoutMs`
    仅当你想要为排队的代理轮次设置单独的安全阀时。

  </Accordion>

  <Accordion title="权限审计不匹配">
    `channels status --probe` 权限检查仅对数字频道 ID 有效。

    如果你使用 slug 键，运行时匹配仍然可以工作，但探测无法完全验证权限。

  </Accordion>

  <Accordion title="私信和配对问题">

    - 私信禁用：`channels.discord.dm.enabled=false`
    - 私信政策禁用：`channels.discord.dmPolicy="disabled"`（旧版：`channels.discord.dm.policy`）
    - 在 `pairing` 模式下等待配对批准

  </Accordion>

  <Accordion title="机器人到机器人循环">
    默认情况下，机器人编写的消息被忽略。

    如果你设置 `channels.discord.allowBots=true`，请使用严格的提及和允许列表规则以避免循环行为。
    首选 `channels.discord.allowBots="mentions"` 以仅接受提及机器人的机器人消息。

  </Accordion>

  <Accordion title="语音 STT 因 DecryptionFailed(...) 而掉线">

    - 保持 OpenClaw 最新（`openclaw update`），以便 Discord 语音接收恢复逻辑存在
    - 确认 `channels.discord.voice.daveEncryption=true`（默认）
    - 从 `channels.discord.voice.decryptionFailureTolerance=24`（上游默认）开始，仅在需要时调整
    - 监视日志：
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - 如果自动重新加入后故障继续，收集日志并与 [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) 比较

  </Accordion>
</AccordionGroup>

## 配置参考指针

主要参考：

- [Configuration reference - Discord](/gateway/configuration-reference#discord)

高信号 Discord 字段：

- 启动/认证：`enabled`、`token`、`accounts.*`、`allowBots`
- 政策：`groupPolicy`、`dm.*`、`guilds.*`、`guilds.*.channels.*`
- 命令：`commands.native`、`commands.useAccessGroups`、`configWrites`、`slashCommand.*`
- 事件队列：`eventQueue.listenerTimeout`（监听器预算）、`eventQueue.maxQueueSize`、`eventQueue.maxConcurrency`
- 入站工作线程：`inboundWorker.runTimeoutMs`
- 回复/历史：`replyToMode`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`
- 传递：`textChunkLimit`、`chunkMode`、`maxLinesPerMessage`
- 流式传输：`streaming`（旧版别名：`streamMode`）、`draftChunk`、`blockStreaming`、`blockStreamingCoalesce`
- 媒体/重试：`mediaMaxMb`、`retry`
  - `mediaMaxMb` 限制 Discord 出站上传（默认：`100MB`）
- 操作：`actions.*`
- 状态：`activity`、`status`、`activityType`、`activityUrl`
- UI：`ui.components.accentColor`
- 功能：`threadBindings`、顶级 `bindings[]`（`type: "acp"`）、`pluralkit`、`execApprovals`、`intents`、`agentComponents`、`heartbeat`、`responsePrefix`

## 安全和操作

- 将机器人令牌视为机密（在受监督环境中首选 `DISCORD_BOT_TOKEN`）。
- 授予最小权限 Discord 权限。
- 如果命令部署/状态过时，重启网关并使用 `openclaw channels status --probe` 重新检查。

## 相关

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Security](/gateway/security)
- [Multi-agent routing](/concepts/multi-agent)
- [Troubleshooting](/channels/troubleshooting)
- [Slash commands](/tools/slash-commands)