---
summary: "Telegram 机器人支持状态、功能和配置"
read_when:
  - 处理 Telegram 功能或 webhook

title: "Telegram"
---

# Telegram（Bot API）

状态：通过 grammY 为机器人 DM + 群组生产就绪。默认模式为长轮询；webhook 模式为可选。

<CardGroup cols={3}>
  <Card title="配对" icon="link" href="/channels/pairing">
    Telegram 的默认 DM 策略是配对。
  </Card>
  <Card title="通道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨通道诊断和修复手册。
  </Card>
  <Card title="网关配置" icon="settings" href="/gateway/configuration">
    完整的通道配置模式和示例。
  </Card>
</CardGroup>

## 快速设置

<Steps>
  <Step title="在 BotFather 中创建机器人令牌">
    打开 Telegram 并与 **@BotFather** 聊天（确认句柄正好是 `@BotFather`）。

    运行 `/newbot`，按照提示操作，并保存令牌。

  </Step>

  <Step title="配置令牌和 DM 策略">

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    环境变量回退：`TELEGRAM_BOT_TOKEN=...`（仅默认账户）。
    Telegram **不**使用 `openclaw channels login telegram`；在配置/环境中配置令牌，然后启动网关。

  </Step>

  <Step title="启动网关并批准第一个 DM">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    配对代码在 1 小时后过期。

  </Step>

  <Step title="将机器人添加到群组">
    将机器人添加到你的群组，然后设置 `channels.telegram.groups` 和 `groupPolicy` 以匹配你的访问模型。
  </Step>
</Steps>

<Note>
令牌解析顺序是账户感知的。实际上，配置值优先于环境变量回退，`TELEGRAM_BOT_TOKEN` 仅适用于默认账户。
</Note>

## Telegram 端设置

<AccordionGroup>
  <Accordion title="隐私模式和群组可见性">
    Telegram 机器人默认为**隐私模式**，这限制了它们接收的群组消息。

    如果机器人必须看到所有群组消息，请执行以下操作之一：

    - 通过 `/setprivacy` 禁用隐私模式，或
    - 使机器人成为群管理员。

    切换隐私模式时，在每个群组中移除并重新添加机器人，以便 Telegram 应用更改。

  </Accordion>

  <Accordion title="群组权限">
    管理员状态在 Telegram 群组设置中控制。

    管理员机器人接收所有群组消息，这对于始终开启的群组行为很有用。

  </Accordion>

  <Accordion title="有用的 BotFather 切换">

    - `/setjoingroups` 允许/拒绝群组添加
    - `/setprivacy` 用于群组可见性行为

  </Accordion>
</AccordionGroup>

## 访问控制和激活

<Tabs>
  <Tab title="DM 策略">
    `channels.telegram.dmPolicy` 控制直接消息访问：

    - `pairing`（默认）
    - `allowlist`（需要 `allowFrom` 中至少有一个发送者 ID）
    - `open`（需要 `allowFrom` 包含 `"*"`）
    - `disabled`

    `channels.telegram.allowFrom` 接受数字 Telegram 用户 ID。接受并标准化 `telegram:` / `tg:` 前缀。
    `dmPolicy: "allowlist"` 且 `allowFrom` 为空会阻止所有 DM，并被配置验证拒绝。
    引导流程接受 `@username` 输入并将其解析为数字 ID。
    如果你升级了，并且你的配置包含 `@username` 允许列表条目，请运行 `openclaw doctor --fix` 来解析它们（尽力而为；需要 Telegram 机器人令牌）。
    如果你之前依赖配对存储允许列表文件，`openclaw doctor --fix` 可以在允许列表流程中（例如当 `dmPolicy: "allowlist"` 尚无非显式 ID 时）将条目恢复到 `channels.telegram.allowFrom`。

    对于单一所有者机器人，更喜欢 `dmPolicy: "allowlist"` 并带有显式数字 `allowFrom` ID，以在配置中保持访问策略的持久性（而不是依赖之前的配对批准）。

    常见混淆：DM 配对批准并不意味着 "此发送者在所有地方都被授权"。
    配对仅授予 DM 访问权限。群组发送者授权仍然来自显式配置允许列表。
    如果你想要 "我被授权一次，DM 和群组命令都可以工作"，请将你的数字 Telegram 用户 ID 放在 `channels.telegram.allowFrom` 中。

    ### 查找你的 Telegram 用户 ID

    更安全（无第三方机器人）：

    1. DM 你的机器人。
    2. 运行 `openclaw logs --follow`。
    3. 读取 `from.id`。

    官方 Bot API 方法：

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    第三方方法（较少隐私）：`@userinfobot` 或 `@getidsbot`。

  </Tab>

  <Tab title="群组策略和允许列表">
    两个控制一起应用：

    1. **哪些群组被允许**（`channels.telegram.groups`）
       - 无 `groups` 配置：
         - 使用 `groupPolicy: "open"`：任何群组都可以通过群组 ID 检查
         - 使用 `groupPolicy: "allowlist"`（默认）：群组在添加 `groups` 条目（或 `"*"`）之前被阻止
       - 配置了 `groups`：充当允许列表（显式 ID 或 `"*"`）

    2. **哪些发送者在群组中被允许**（`channels.telegram.groupPolicy`）
       - `open`
       - `allowlist`（默认）
       - `disabled`

    `groupAllowFrom` 用于群组发送者过滤。如果未设置，Telegram 回退到 `allowFrom`。
    `groupAllowFrom` 条目应为数字 Telegram 用户 ID（`telegram:` / `tg:` 前缀被标准化）。
    不要在 `groupAllowFrom` 中放入 Telegram 群组或超级群组聊天 ID。负聊天 ID 属于 `channels.telegram.groups` 下。
    非数字条目在发送者授权时被忽略。
    安全边界（`2026.2.25+`）：群组发送者认证**不**继承 DM 配对存储批准。
    配对保持仅 DM。对于群组，设置 `groupAllowFrom` 或每个群组/每个主题的 `allowFrom`。
    如果未设置 `groupAllowFrom`，Telegram 回退到配置 `allowFrom`，而不是配对存储。
    单一所有者机器人的实用模式：在 `channels.telegram.allowFrom` 中设置你的用户 ID，保持 `groupAllowFrom` 未设置，并在 `channels.telegram.groups` 下允许目标群组。
    运行时注意：如果 `channels.telegram` 完全缺失，运行时默认为故障关闭的 `groupPolicy="allowlist"`，除非显式设置了 `channels.defaults.groupPolicy`。

    示例：允许一个特定群组中的任何成员：

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

    示例：仅允许一个特定群组中的特定用户：

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          requireMention: true,
          allowFrom: ["8734062810", "745123456"],
        },
      },
    },
  },
}
```

    <Warning>
      常见错误：`groupAllowFrom` 不是 Telegram 群组允许列表。

      - 将负 Telegram 群组或超级群组聊天 ID（如 `-1001234567890`）放在 `channels.telegram.groups` 下。
      - 将 Telegram 用户 ID（如 `8734062810`）放在 `groupAllowFrom` 下，当你想要限制允许群组内哪些人可以触发机器人时。
      - 仅当你希望允许群组的任何成员能够与机器人交谈时，才使用 `groupAllowFrom: ["*"]`。
    </Warning>

  </Tab>

  <Tab title="提及行为">
    默认情况下，群组回复需要提及。

    提及可以来自：

    - 原生 `@botusername` 提及，或
    - 提及模式在：
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    会话级命令切换：

    - `/activation always`
    - `/activation mention`

    这些仅更新会话状态。使用配置进行持久化。

    持久配置示例：

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    获取群组聊天 ID：

    - 将群组消息转发给 `@userinfobot` / `@getidsbot`
    - 或从 `openclaw logs --follow` 读取 `chat.id`
    - 或检查 Bot API `getUpdates`

  </Tab>
</Tabs>

## 运行时行为

- Telegram 由网关进程拥有。
- 路由是确定性的：Telegram 入站回复回 Telegram（模型不选择通道）。
- 入站消息标准化为带有回复元数据和媒体占位符的共享通道信封。
- 群组会话按群组 ID 隔离。论坛主题附加 `:topic:<threadId>` 以保持主题隔离。
- DM 消息可以携带 `message_thread_id`；OpenClaw 使用线程感知的会话键路由它们，并为回复保留线程 ID。
- 长轮询使用 grammY 运行器，具有每聊天/每线程排序。整体运行器接收器并发使用 `agents.defaults.maxConcurrent`。
- Telegram Bot API 不支持已读回执（`sendReadReceipts` 不适用）。

## 功能参考

<AccordionGroup>
  <Accordion title="实时流预览（消息编辑）">
    OpenClaw 可以实时流式传输部分回复：

    - 直接聊天：预览消息 + `editMessageText`
    - 群组/主题：预览消息 + `editMessageText`

    要求：

    - `channels.telegram.streaming` 为 `off | partial | block | progress`（默认：`partial`）
    - `progress` 在 Telegram 上映射为 `partial`（与跨通道命名兼容）
    - 旧版 `channels.telegram.streamMode` 和布尔 `streaming` 值会自动映射

    对于纯文本回复：

    - DM：OpenClaw 保持相同的预览消息并在原地执行最终编辑（无第二条消息）
    - 群组/主题：OpenClaw 保持相同的预览消息并在原地执行最终编辑（无第二条消息）

    对于复杂回复（例如媒体有效负载），OpenClaw 回退到正常的最终传递，然后清理预览消息。

    预览流与块流是分开的。当为 Telegram 显式启用块流时，OpenClaw 跳过预览流以避免双重流。

    如果原生草稿传输不可用/被拒绝，OpenClaw 自动回退到 `sendMessage` + `editMessageText`。

    Telegram 专用推理流：

    - `/reasoning stream` 在生成时将推理发送到实时预览
    - 最终答案发送时不带推理文本

  </Accordion>

  <Accordion title="格式和 HTML 回退">
    出站文本使用 Telegram `parse_mode: "HTML"`。

    - 类 Markdown 文本被渲染为 Telegram 安全的 HTML。
    - 原始模型 HTML 被转义以减少 Telegram 解析失败。
    - 如果 Telegram 拒绝解析的 HTML，OpenClaw 作为纯文本重试。

    链接预览默认启用，可以通过 `channels.telegram.linkPreview: false` 禁用。

  </Accordion>

  <Accordion title="原生命令和自定义命令">
    Telegram 命令菜单注册在启动时通过 `setMyCommands` 处理。

    原生命令默认值：

    - `commands.native: "auto"` 为 Telegram 启用原生命令

    添加自定义命令菜单条目：

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

    规则：

    - 名称被标准化（去除前导 `/`，小写）
    - 有效模式：`a-z`、`0-9`、`_`，长度 `1..32`
    - 自定义命令不能覆盖原生命令
    - 冲突/重复被跳过并记录

    注意：

    - 自定义命令仅为菜单条目；它们不会自动实现行为
    - 插件/技能命令即使未在 Telegram 菜单中显示，仍然可以在输入时工作

    如果禁用原生命令，内置命令将被移除。自定义/插件命令如果配置仍然可以注册。

    常见设置失败：

    - `setMyCommands failed` 带有 `BOT_COMMANDS_TOO_MUCH` 意味着 Telegram 菜单在修剪后仍然溢出；减少插件/技能/自定义命令或禁用 `channels.telegram.commands.native`。
    - `setMyCommands failed` 带有网络/获取错误通常意味着对 `api.telegram.org` 的出站 DNS/HTTPS 被阻止。

    ### 设备配对命令（`device-pair` 插件）

    当安装了 `device-pair` 插件时：

    1. `/pair` 生成设置代码
    2. 在 iOS 应用中粘贴代码
    3. `/pair pending` 列出待处理请求（包括角色/作用域）
    4. 批准请求：
       - `/pair approve <requestId>` 用于显式批准
       - 当只有一个待处理请求时 `/pair approve`
       - `/pair approve latest` 用于最新的

    设置代码携带短期引导令牌。内置引导传递将主节点令牌保持在 `scopes: []`；任何传递的操作员令牌保持绑定到 `operator.approvals`、`operator.read`、`operator.talk.secrets` 和 `operator.write`。引导作用域检查是角色前缀的，因此操作员允许列表仅满足操作员请求；非操作员角色仍然需要在自己的角色前缀下的作用域。

    如果设备使用更改的认证详细信息重试（例如角色/作用域/公钥），之前的待处理请求会被取代，新请求使用不同的 `requestId`。在批准前重新运行 `/pair pending`。

    更多详情：[配对](/channels/pairing#pair-via-telegram-recommended-for-ios)。

  </Accordion>

  <Accordion title="内联按钮">
    配置内联键盘作用域：

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    每个账户覆盖：

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    作用域：

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist`（默认）

    旧版 `capabilities: ["inlineButtons"]` 映射到 `inlineButtons: "all"`。

    消息操作示例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

    回调点击作为文本传递给代理：
    `callback_data: <value>`

  </Accordion>

  <Accordion title="Telegram 消息操作（适用于代理和自动化）">
    Telegram 工具操作包括：

    - `sendMessage`（`to`、`content`、可选 `mediaUrl`、`replyToMessageId`、`messageThreadId`）
    - `react`（`chatId`、`messageId`、`emoji`）
    - `deleteMessage`（`chatId`、`messageId`）
    - `editMessage`（`chatId`、`messageId`、`content`）
    - `createForumTopic`（`chatId`、`name`、可选 `iconColor`、`iconCustomEmojiId`）

    通道消息操作公开符合人体工程学的别名（`send`、`react`、`delete`、`edit`、`sticker`、`sticker-search`、`topic-create`）。

    门控控制：

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker`（默认：禁用）

    注意：`edit` 和 `topic-create` 目前默认启用，没有单独的 `channels.telegram.actions.*` 切换。
    运行时发送使用活动的配置/密钥快照（启动/重新加载），因此操作路径不会在每次发送时执行临时 SecretRef 重新解析。

    反应删除语义：[/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="回复线程标签">
    Telegram 支持生成输出中的显式回复线程标签：

    - `[[reply_to_current]]` 回复触发消息
    - `[[reply_to:<id>]]` 回复特定的 Telegram 消息 ID

    `channels.telegram.replyToMode` 控制处理：

    - `off`（默认）
    - `first`
    - `all`

    注意：`off` 禁用隐式回复线程。显式 `[[reply_to_*]]` 标签仍然被尊重。

  </Accordion>

  <Accordion title="论坛主题和线程行为">
    论坛超级群组：

    - 主题会话键附加 `:topic:<threadId>`
    - 回复和输入针对主题线程
    - 主题配置路径：
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    一般主题（`threadId=1`）特殊情况：

    - 消息发送省略 `message_thread_id`（Telegram 拒绝 `sendMessage(...thread_id=1)`）
    - 输入操作仍然包含 `message_thread_id`

    主题继承：主题条目继承群组设置，除非被覆盖（`requireMention`、`allowFrom`、`skills`、`systemPrompt`、`enabled`、`groupPolicy`）。
    `agentId` 仅针对主题，不继承自群组默认值。

    **每个主题的代理路由**：每个主题可以通过在主题配置中设置 `agentId` 路由到不同的代理。这为每个主题提供了自己的隔离工作区、内存和会话。示例：

    ```json5
    {
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },      // 一般主题 → main 代理
                "3": { agentId: "zu" },        // 开发主题 → zu 代理
                "5": { agentId: "coder" }      // 代码审查 → coder 代理
              }
            }
          }
        }
      }
    }
    ```

    每个主题然后有自己的会话键：`agent:zu:telegram:group:-1001234567890:topic:3`

    **持久 ACP 主题绑定**：论坛主题可以通过顶级类型化 ACP 绑定固定 ACP 测试台会话：

    - `bindings[]` 带有 `type: "acp"` 和 `match.channel: "telegram"`

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
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-1001234567890:topic:42" },
          },
        },
      ],
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    }
    ```

    这目前仅限于群组和超级群组中的论坛主题。

    **从聊天生成的线程绑定 ACP**：

    - `/acp spawn <agent> --thread here|auto` 可以将当前 Telegram 主题绑定到新的 ACP 会话。
    - 后续主题消息直接路由到绑定的 ACP 会话（不需要 `/acp steer`）。
    - OpenClaw 在成功绑定后将生成确认消息固定在主题中。
    - 需要 `channels.telegram.threadBindings.spawnAcpSessions=true`。

    模板上下文包括：

    - `MessageThreadId`
    - `IsForum`

    DM 线程行为：

    - 带有 `message_thread_id` 的私人聊天保持 DM 路由，但使用线程感知的会话键/回复目标。

  </Accordion>

  <Accordion title="音频、视频和贴纸">
    ### 音频消息

    Telegram 区分语音笔记和音频文件。

    - 默认：音频文件行为
    - 代理回复中的标签 `[[audio_as_voice]]` 强制语音笔记发送

    消息操作示例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### 视频消息

    Telegram 区分视频文件和视频笔记。

    消息操作示例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    视频笔记不支持标题；提供的消息文本单独发送。

    ### 贴纸

    入站贴纸处理：

    - 静态 WEBP：下载并处理（占位符 `<media:sticker>`）
    - 动画 TGS：跳过
    - 视频 WEBM：跳过

    贴纸上下文字段：

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    贴纸缓存文件：

    - `~/.openclaw/telegram/sticker-cache.json`

    贴纸被描述一次（如果可能）并缓存以减少重复的视觉调用。

    启用贴纸操作：

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

    发送贴纸操作：

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    搜索缓存的贴纸：

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="反应通知">
    Telegram 反应作为 `message_reaction` 更新到达（与消息有效负载分开）。

    启用时，OpenClaw 入队系统事件，如：

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    配置：

    - `channels.telegram.reactionNotifications`：`off | own | all`（默认：`own`）
    - `channels.telegram.reactionLevel`：`off | ack | minimal | extensive`（默认：`minimal`）

    注意：

    - `own` 意味着仅对机器人发送的消息的用户反应（通过已发送消息缓存尽力而为）。
    - 反应事件仍然尊重 Telegram 访问控制（`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`）；未授权的发送者被丢弃。
    - Telegram 在反应更新中不提供线程 ID。
      - 非论坛群组路由到群组聊天会话
      - 论坛群组路由到群组一般主题会话（` :topic:1`），而不是确切的原始主题

    `allowed_updates` 对于轮询/webhook 自动包含 `message_reaction`。

  </Accordion>

  <Accordion title="确认反应">
    `ackReaction` 在 OpenClaw 处理入站消息时发送确认表情符号。

    解析顺序：

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - 代理身份表情符号回退（`agents.list[].identity.emoji`，否则 "👀"）

    注意：

    - Telegram 期望 Unicode 表情符号（例如 "👀"）。
    - 使用 `""` 禁用通道或账户的反应。

  </Accordion>

  <Accordion title="从 Telegram 事件和命令写入配置">
    通道配置写入默认启用（`configWrites !== false`）。

    Telegram 触发的写入包括：

    - 群组迁移事件（`migrate_to_chat_id`）以更新 `channels.telegram.groups`
    - `/config set` 和 `/config unset`（需要命令启用）

    禁用：

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="长轮询 vs webhook">
    默认：长轮询。

    Webhook 模式：

    - 设置 `channels.telegram.webhookUrl`
    - 设置 `channels.telegram.webhookSecret`（设置 webhook URL 时必需）
    - 可选 `channels.telegram.webhookPath`（默认 `/telegram-webhook`）
    - 可选 `channels.telegram.webhookHost`（默认 `127.0.0.1`）
    - 可选 `channels.telegram.webhookPort`（默认 `8787`）

    Webhook 模式的默认本地监听器绑定到 `127.0.0.1:8787`。

    如果你的公共端点不同，请在前面放置反向代理并将 `webhookUrl` 指向公共 URL。
    当你有意需要外部入口时，设置 `webhookHost`（例如 `0.0.0.0`）。

  </Accordion>

  <Accordion title="限制、重试和 CLI 目标">
    - `channels.telegram.textChunkLimit` 默认值为 4000。
    - `channels.telegram.chunkMode="newline"` 优先段落边界（空行），然后是长度分割。
    - `channels.telegram.mediaMaxMb`（默认 100）限制入站和出站 Telegram 媒体大小。
    - `channels.telegram.timeoutSeconds` 覆盖 Telegram API 客户端超时（如果未设置，应用 grammY 默认值）。
    - 群组上下文历史使用 `channels.telegram.historyLimit` 或 `messages.groupChat.historyLimit`（默认 50）；`0` 禁用。
    - 回复/引用/转发补充上下文当前按原样传递。
    - Telegram 允许列表主要控制谁可以触发代理，而不是完整的补充上下文编辑边界。
    - DM 历史控制：
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - `channels.telegram.retry` 配置适用于 Telegram 发送助手（CLI/工具/操作），用于可恢复的出站 API 错误。

    CLI 发送目标可以是数字聊天 ID 或用户名：

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

    Telegram 投票使用 `openclaw message poll` 并支持论坛主题：

```bash
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300 --poll-public
```

    Telegram 专用投票标志：

    - `--poll-duration-seconds`（5-600）
    - `--poll-anonymous`
    - `--poll-public`
    - `--thread-id` 用于论坛主题（或使用 `:topic:` 目标）

    Telegram 发送还支持：

    - `--buttons` 用于内联键盘，当 `channels.telegram.capabilities.inlineButtons` 允许时
    - `--force-document` 将出站图像和 GIF 作为文档发送，而不是压缩的照片或动画媒体上传

    操作门控：

    - `channels.telegram.actions.sendMessage=false` 禁用出站 Telegram 消息，包括投票
    - `channels.telegram.actions.poll=false` 禁用 Telegram 投票创建，同时保持常规发送启用

  </Accordion>

  <Accordion title="Telegram 中的执行批准">
    Telegram 支持批准者 DM 中的执行批准，并可选择在原始聊天或主题中发布批准提示。

    配置路径：

    - `channels.telegram.execApprovals.enabled`
    - `channels.telegram.execApprovals.approvers`（可选；当可能时，回退到从 `allowFrom` 和直接 `defaultTo` 推断的数字所有者 ID）
    - `channels.telegram.execApprovals.target`（`dm` | `channel` | `both`，默认：`dm`）
    - `agentFilter`、`sessionFilter`

    批准者必须是数字 Telegram 用户 ID。当 `enabled` 未设置或为 `"auto"` 且至少可以解析一个批准者时（从 `execApprovals.approvers` 或从账户的数字所有者配置（`allowFrom` 和直接消息 `defaultTo`）），Telegram 自动启用原生执行批准。设置 `enabled: false` 以明确禁用 Telegram 作为原生批准客户端。否则，批准请求回退到其他配置的批准路由或执行批准回退策略。

    Telegram 还渲染其他聊天通道使用的共享批准按钮。原生 Telegram 适配器主要添加批准者 DM 路由、通道/主题广播和交付前的输入提示。
    当这些按钮存在时，它们是主要的批准 UX；OpenClaw
    应该仅在工具结果表示聊天批准不可用或手动批准是唯一路径时才包含手动 `/approve` 命令。

    交付规则：

    - `target: "dm"` 仅向解析的批准者 DM 发送批准提示
    - `target: "channel"` 将提示发送回原始 Telegram 聊天/主题
    - `target: "both"` 发送到批准者 DM 和原始聊天/主题

    只有解析的批准者可以批准或拒绝。非批准者不能使用 `/approve` 且不能使用 Telegram 批准按钮。

    批准解析行为：

    - 前缀为 `plugin:` 的 ID 始终通过插件批准解析。
    - 其他批准 ID 首先尝试 `exec.approval.resolve`。
    - 如果 Telegram 也被授权用于插件批准，并且网关表示
      执行批准未知/过期，Telegram 通过
      `plugin.approval.resolve` 重试一次。
    - 真正的执行批准拒绝/错误不会静默地回退到插件
      批准解析。

    通道交付在聊天中显示命令文本，因此仅在受信任的群组/主题中启用 `channel` 或 `both`。当提示落在论坛主题中时，OpenClaw 为批准提示和批准后跟进保留主题。执行批准默认在 30 分钟后过期。

    内联批准按钮还取决于 `channels.telegram.capabilities.inlineButtons` 允许目标表面（`dm`、`group` 或 `all`）。

    相关文档：[执行批准](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## 错误回复控制

当代理遇到交付或提供者错误时，Telegram 可以用错误文本回复或抑制它。两个配置键控制此行为：

| 键                                  | 值                | 默认值  | 描述                                                             |
| ----------------------------------- | ----------------- | ------- | ---------------------------------------------------------------- |
| `channels.telegram.errorPolicy`     | `reply`, `silent` | `reply` | `reply` 向聊天发送友好的错误消息。`silent` 完全抑制错误回复。    |
| `channels.telegram.errorCooldownMs` | 数字 (ms)         | `60000` | 同一聊天之间错误回复的最小时间。防止在中断期间出现错误垃圾信息。 |

支持每个账户、每个群组和每个主题的覆盖（与其他 Telegram 配置键相同的继承）。

```json5
{
  channels: {
    telegram: {
      errorPolicy: "reply",
      errorCooldownMs: 120000,
      groups: {
        "-1001234567890": {
          errorPolicy: "silent", // 在此群组中抑制错误
        },
      },
    },
  },
}
```

## 故障排除

<AccordionGroup>
  <Accordion title="机器人不响应非提及群组消息">

    - 如果 `requireMention=false`，Telegram 隐私模式必须允许完全可见性。
      - BotFather：`/setprivacy` → 禁用
      - 然后从群组中移除并重新添加机器人
    - `openclaw channels status` 当配置期望未提及的群组消息时发出警告。
    - `openclaw channels status --probe` 可以检查显式数字群组 ID；通配符 `"*"` 无法进行成员资格探测。
    - 快速会话测试：`/activation always`。

  </Accordion>

  <Accordion title="机器人根本看不到群组消息">

    - 当 `channels.telegram.groups` 存在时，必须列出群组（或包含 `"*"`）
    - 验证机器人在群组中的成员身份
    - 查看日志：`openclaw logs --follow` 了解跳过原因

  </Accordion>

  <Accordion title="命令部分工作或完全不工作">

    - 授权你的发送者身份（配对和/或数字 `allowFrom`）
    - 即使群组策略为 `open`，命令授权仍然适用
    - `setMyCommands failed` 带有 `BOT_COMMANDS_TOO_MUCH` 意味着原生菜单条目太多；减少插件/技能/自定义命令或禁用原生菜单
    - `setMyCommands failed` 带有网络/获取错误通常表示 DNS/HTTPS 到 `api.telegram.org` 的可达性问题

  </Accordion>

  <Accordion title="轮询或网络不稳定">

    - Node 22+ + 自定义 fetch/代理如果 AbortSignal 类型不匹配，可能会触发立即中止行为。
    - 某些主机首先将 `api.telegram.org` 解析为 IPv6；损坏的 IPv6 出口可能导致间歇性 Telegram API 失败。
    - 如果日志包含 `TypeError: fetch failed` 或 `Network request for 'getUpdates' failed!`，OpenClaw 现在将这些重试为可恢复的网络错误。
    - 在具有不稳定直接出口/TLS 的 VPS 主机上，通过 `channels.telegram.proxy` 路由 Telegram API 调用：

```yaml
channels:
  telegram:
    proxy: socks5://<user>:<password>@proxy-host:1080
```

    - Node 22+ 默认 `autoSelectFamily=true`（WSL2 除外）和 `dnsResultOrder=ipv4first`。
    - 如果你的主机是 WSL2 或明确使用 IPv4 唯一行为更好，强制族选择：

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

    - RFC 2544 基准测试范围答案 (`198.18.0.0/15`) 默认已被允许
      用于 Telegram 媒体下载。如果受信任的假 IP 或
      透明代理在媒体下载期间将 `api.telegram.org` 重写为其他
      私有/内部/特殊用途地址，你可以选择
      加入 Telegram 唯一绕过：

```yaml
channels:
  telegram:
    network:
      dangerouslyAllowPrivateNetwork: true
```

    - 相同的选择加入在
      `channels.telegram.accounts.<accountId>.network.dangerouslyAllowPrivateNetwork` 每账户可用。
    - 如果你的代理将 Telegram 媒体主机解析为 `198.18.x.x`，首先保持危险标志关闭。Telegram 媒体默认已经允许 RFC 2544
      基准测试范围。

    <Warning>
      `channels.telegram.network.dangerouslyAllowPrivateNetwork` 削弱 Telegram
      媒体 SSRF 保护。仅在受信任的操作员控制的代理中使用
      环境，如 Clash、Mihomo 或 Surge 假 IP 路由，当它们
      合成 RFC 2544 基准测试范围之外的私有或特殊用途答案时。对于正常的公共互联网 Telegram 访问，请保持关闭。
    </Warning>

    - 环境覆盖（临时）：
      - `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`
    - 验证 DNS 答案：

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

更多帮助：[通道故障排除](/channels/troubleshooting)。

## Telegram 配置参考指针

主要参考：

- `channels.telegram.enabled`：启用/禁用通道启动。
- `channels.telegram.botToken`：机器人令牌（BotFather）。
- `channels.telegram.tokenFile`：从常规文件路径读取令牌。符号链接被拒绝。
- `channels.telegram.dmPolicy`：`pairing | allowlist | open | disabled`（默认：配对）。
- `channels.telegram.allowFrom`：DM 允许列表（数字 Telegram 用户 ID）。`allowlist` 需要至少一个发送者 ID。`open` 需要 `"*"`。`openclaw doctor --fix` 可以将旧版 `@username` 条目解析为 ID，并可以在允许列表迁移流程中从配对存储文件恢复允许列表条目。
- `channels.telegram.actions.poll`：启用或禁用 Telegram 投票创建（默认：启用；仍然需要 `sendMessage`）。
- `channels.telegram.defaultTo`：当未提供显式 `--reply-to` 时，CLI `--deliver` 使用的默认 Telegram 目标。
- `channels.telegram.groupPolicy`：`open | allowlist | disabled`（默认：allowlist）。
- `channels.telegram.groupAllowFrom`：群组发送者允许列表（数字 Telegram 用户 ID）。`openclaw doctor --fix` 可以将旧版 `@username` 条目解析为 ID。非数字条目在认证时被忽略。群组认证不使用 DM 配对存储回退（`2026.2.25+`）。
- 多账户优先级：
  - 当配置了两个或更多账户 ID 时，设置 `channels.telegram.defaultAccount`（或包含 `channels.telegram.accounts.default`）以明确默认路由。
  - 如果两者都未设置，OpenClaw 回退到第一个标准化的账户 ID，`openclaw doctor` 发出警告。
  - `channels.telegram.accounts.default.allowFrom` 和 `channels.telegram.accounts.default.groupAllowFrom` 仅适用于 `default` 账户。
  - 命名账户在未设置账户级值时继承 `channels.telegram.allowFrom` 和 `channels.telegram.groupAllowFrom`。
  - 命名账户不继承 `channels.telegram.accounts.default.allowFrom` / `groupAllowFrom`。
- `channels.telegram.groups`：每群组默认值 + 允许列表（使用 `"*"` 表示全局默认值）。
  - `channels.telegram.groups.<id>.groupPolicy`：每群组 `groupPolicy` 覆盖（`open | allowlist | disabled`）。
  - `channels.telegram.groups.<id>.requireMention`：提及门控默认值。
  - `channels.telegram.groups.<id>.skills`：技能过滤器（省略 = 所有技能，空 = 无）。
  - `channels.telegram.groups.<id>.allowFrom`：每群组发送者允许列表覆盖。
  - `channels.telegram.groups.<id>.systemPrompt`：群组的额外系统提示。
  - `channels.telegram.groups.<id>.enabled`：当 `false` 时禁用群组。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`：每主题覆盖（群组字段 + 主题专用 `agentId`）。
  - `channels.telegram.groups.<id>.topics.<threadId>.agentId`：将此主题路由到特定代理（覆盖群组级和绑定路由）。
- `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`：每主题 `groupPolicy` 覆盖（`open | allowlist | disabled`）。
- `channels.telegram.groups.<id>.topics.<threadId>.requireMention`：每主题提及门控覆盖。
- 顶级 `bindings[]` 带有 `type: "acp"` 和 `match.peer.id` 中的规范主题 ID `chatId:topic:topicId`：持久 ACP 主题绑定字段（见 [ACP Agents](/tools/acp-agents#channel-specific-settings)）。
- `channels.telegram.direct.<id>.topics.<threadId>.agentId`：将 DM 主题路由到特定代理（与论坛主题相同的行为）。
- `channels.telegram.execApprovals.enabled`：为此账户启用 Telegram 作为基于聊天的执行批准客户端。
- `channels.telegram.execApprovals.approvers`：允许批准或拒绝执行请求的 Telegram 用户 ID。当 `channels.telegram.allowFrom` 或直接 `channels.telegram.defaultTo` 已经标识所有者时可选。
- `channels.telegram.execApprovals.target`：`dm | channel | both`（默认：`dm`）。`channel` 和 `both` 在存在时保留原始 Telegram 主题。
- `channels.telegram.execApprovals.agentFilter`：转发的批准提示的可选代理 ID 过滤器。
- `channels.telegram.execApprovals.sessionFilter`：转发的批准提示的可选会话键过滤器（子字符串或正则表达式）。
- `channels.telegram.accounts.<account>.execApprovals`：每账户覆盖 Telegram 执行批准路由和批准者授权。
- `channels.telegram.capabilities.inlineButtons`：`off | dm | group | all | allowlist`（默认：allowlist）。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`：每账户覆盖。
- `channels.telegram.commands.nativeSkills`：启用/禁用 Telegram 原生技能命令。
- `channels.telegram.replyToMode`：`off | first | all`（默认：`off`）。
- `channels.telegram.textChunkLimit`：出站分块大小（字符）。
- `channels.telegram.chunkMode`：`length`（默认）或 `newline` 在长度分块之前按空行（段落边界）分割。
- `channels.telegram.linkPreview`：切换出站消息的链接预览（默认：true）。
- `channels.telegram.streaming`：`off | partial | block | progress`（实时流预览；默认：`partial`；`progress` 映射到 `partial`；`block` 是旧版预览模式兼容性）。Telegram 预览流使用单个预览消息，该消息在原地编辑。
- `channels.telegram.mediaMaxMb`：入站/出站 Telegram 媒体上限（MB，默认：100）。
- `channels.telegram.retry`：Telegram 发送助手（CLI/工具/操作）在可恢复的出站 API 错误上的重试策略（尝试次数、minDelayMs、maxDelayMs、抖动）。
- `channels.telegram.network.autoSelectFamily`：覆盖 Node autoSelectFamily（true=启用，false=禁用）。在 Node 22+ 上默认为启用，WSL2 默认为禁用。
- `channels.telegram.network.dnsResultOrder`：覆盖 DNS 结果顺序（`ipv4first` 或 `verbatim`）。在 Node 22+ 上默认为 `ipv4first`。
- `channels.telegram.network.dangerouslyAllowPrivateNetwork`：危险的选择加入，用于受信任的假 IP 或透明代理环境，其中 Telegram 媒体下载将 `api.telegram.org` 解析为默认 RFC 2544 基准测试范围允许之外的私有/内部/特殊用途地址。
- `channels.telegram.proxy`：Bot API 调用的代理 URL（SOCKS/HTTP）。
- `channels.telegram.webhookUrl`：启用 webhook 模式（需要 `channels.telegram.webhookSecret`）。
- `channels.telegram.webhookSecret`：webhook 密钥（设置 webhookUrl 时必需）。
- `channels.telegram.webhookPath`：本地 webhook 路径（默认 `/telegram-webhook`）。
- `channels.telegram.webhookHost`：本地 webhook 绑定主机（默认 `127.0.0.1`）。
- `channels.telegram.webhookPort`：本地 webhook 绑定端口（默认 `8787`）。
- `channels.telegram.actions.reactions`：门控 Telegram 工具反应。
- `channels.telegram.actions.sendMessage`：门控 Telegram 工具消息发送。
- `channels.telegram.actions.deleteMessage`：门控 Telegram 工具消息删除。
- `channels.telegram.actions.sticker`：门控 Telegram 贴纸操作 — 发送和搜索（默认：false）。
- `channels.telegram.reactionNotifications`：`off | own | all` — 控制哪些反应触发系统事件（默认：未设置时为 `own`）。
- `channels.telegram.reactionLevel`：`off | ack | minimal | extensive` — 控制代理的反应能力（默认：未设置时为 `minimal`）。
- `channels.telegram.errorPolicy`：`reply | silent` — 控制错误回复行为（默认：`reply`）。支持每账户/群组/主题覆盖。
- `channels.telegram.errorCooldownMs`：同一聊天之间错误回复的最小毫秒数（默认：`60000`）。防止在中断期间出现错误垃圾信息。

- [配置参考 - Telegram](/gateway/configuration-reference#telegram)

Telegram 专用高信号字段：

- 启动/认证：`enabled`、`botToken`、`tokenFile`、`accounts.*`（`tokenFile` 必须指向常规文件；符号链接被拒绝）
- 访问控制：`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`、`groups.*.topics.*`、顶级 `bindings[]`（`type: "acp"`）
- 执行批准：`execApprovals`、`accounts.*.execApprovals`
- 命令/菜单：`commands.native`、`commands.nativeSkills`、`customCommands`
- 线程/回复：`replyToMode`
- 流：`streaming`（预览）、`blockStreaming`
- 格式/交付：`textChunkLimit`、`chunkMode`、`linkPreview`、`responsePrefix`
- 媒体/网络：`mediaMaxMb`、`timeoutSeconds`、`retry`、`network.autoSelectFamily`、`network.dangerouslyAllowPrivateNetwork`、`proxy`
- webhook：`webhookUrl`、`webhookSecret`、`webhookPath`、`webhookHost`
- 操作/功能：`capabilities.inlineButtons`、`actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- 反应：`reactionNotifications`、`reactionLevel`
- 错误：`errorPolicy`、`errorCooldownMs`
- 写入/历史：`configWrites`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`

## 相关

- [配对](/channels/pairing)
- [群组](/channels/groups)
- [安全](/gateway/security)
- [通道路由](/channels/channel-routing)
- [多代理路由](/concepts/multi-agent)
- [故障排除](/channels/troubleshooting)
