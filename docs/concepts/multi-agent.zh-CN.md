---
summary: "多代理路由：隔离的代理、通道账户和绑定"
title: 多代理路由
read_when: "您希望在一个网关进程中使用多个隔离的代理（工作区 + 身份验证）。"
status: active
---

# 多代理路由

目标：在一个运行的网关中使用多个*隔离*的代理（单独的工作区 + `agentDir` + 会话），以及多个通道账户（例如两个 WhatsApp）。入站消息通过绑定路由到代理。

## 什么是"一个代理"？

**代理**是一个完全作用域的大脑，拥有自己的：

- **工作区**（文件、AGENTS.md/SOUL.md/USER.md、本地笔记、角色规则）。
- **状态目录**（`agentDir`），用于身份验证配置文件、模型注册表和每代理配置。
- **会话存储**（聊天历史 + 路由状态），位于 `~/.openclaw/agents/<agentId>/sessions`。

身份验证配置文件是**每代理**的。每个代理从自己的目录读取：

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

`sessions_history` 也是这里更安全的跨会话回忆路径：它返回一个有界、净化的视图，而不是原始的记录转储。助手回忆会在编辑/截断之前剥离思考标签、`<relevant-memories>` 脚手架、纯文本工具调用 XML 有效负载（包括 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>`、`<function_calls>...</function_calls>` 和截断的工具调用块）、降级的工具调用脚手架、泄漏的 ASCII/全宽模型控制令牌以及格式错误的 MiniMax 工具调用 XML。

主代理凭据**不会**自动共享。切勿在多个代理之间重用 `agentDir`（这会导致身份验证/会话冲突）。如果您想共享凭据，请将 `auth-profiles.json` 复制到其他代理的 `agentDir` 中。

技能从每个代理工作区以及共享根目录（如 `~/.openclaw/skills`）加载，然后在配置时按有效的代理技能允许列表进行过滤。使用 `agents.defaults.skills` 作为共享基线，使用 `agents.list[].skills` 作为每代理替换。请参阅 [技能：每代理与共享](/tools/skills#per-agent-vs-shared-skills) 和 [技能：代理技能允许列表](/tools/skills#agent-skill-allowlists)。

网关可以托管**一个代理**（默认）或**多个代理**并排运行。

**工作区注意事项：**每个代理的工作区是**默认 cwd**，不是硬沙箱。相对路径在工作区内解析，但绝对路径可以到达其他主机位置，除非启用了沙箱。请参阅 [沙箱](/gateway/sandboxing)。

## 路径（快速映射）

- 配置：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- 状态目录：`~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- 工作区：`~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- 代理目录：`~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- 会话：`~/.openclaw/agents/<agentId>/sessions`

### 单代理模式（默认）

如果您什么都不做，OpenClaw 运行单个代理：

- `agentId` 默认为 **`main`**。
- 会话键为 `agent:main:<mainKey>`。
- 工作区默认为 `~/.openclaw/workspace`（或当设置 `OPENCLAW_PROFILE` 时为 `~/.openclaw/workspace-<profile>`）。
- 状态默认为 `~/.openclaw/agents/main/agent`。

## 代理助手

使用代理向导添加新的隔离代理：

```bash
openclaw agents add work
```

然后添加 `bindings`（或让向导完成）来路由入站消息。

验证：

```bash
openclaw agents list --bindings
```

## 快速开始

<Steps>
  <Step title="创建每个代理工作区">

使用向导或手动创建工作区：

```bash
openclaw agents add coding
openclaw agents add social
```

每个代理都会获得自己的工作区，包含 `SOUL.md`、`AGENTS.md` 和可选的 `USER.md`，以及专用的 `agentDir` 和会话存储，位于 `~/.openclaw/agents/<agentId>` 下。

  </Step>

  <Step title="创建通道账户">

在您首选的通道上为每个代理创建一个账户：

- Discord：每个代理一个机器人，启用消息内容意图，复制每个令牌。
- Telegram：通过 BotFather 为每个代理创建一个机器人，复制每个令牌。
- WhatsApp：为每个账户链接每个电话号码。

```bash
openclaw channels login --channel whatsapp --account work
```

请参阅通道指南：[Discord](/channels/discord)、[Telegram](/channels/telegram)、[WhatsApp](/channels/whatsapp)。

  </Step>

  <Step title="添加代理、账户和绑定">

在 `agents.list` 下添加代理，在 `channels.<channel>.accounts` 下添加通道账户，并使用 `bindings` 连接它们（示例如下）。

  </Step>

  <Step title="重启并验证">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

  </Step>
</Steps>

## 多个代理 = 多个人，多种个性

使用**多个代理**，每个 `agentId` 成为**完全隔离的角色**：

- **不同的电话号码/账户**（每个通道 `accountId`）。
- **不同的个性**（每代理工作区文件，如 `AGENTS.md` 和 `SOUL.md`）。
- **单独的身份验证 + 会话**（除非明确启用，否则没有交叉对话）。

这允许**多个人**共享一个网关服务器，同时保持他们的 AI"大脑"和数据隔离。

## 跨代理 QMD 内存搜索

如果一个代理应该搜索另一个代理的 QMD 会话记录，在 `agents.list[].memorySearch.qmd.extraCollections` 下添加额外的集合。仅当每个代理都应继承相同的共享记录集合时，才使用 `agents.defaults.memorySearch.qmd.extraCollections`。

```json5
{
  agents: {
    defaults: {
      workspace: "~/workspaces/main",
      memorySearch: {
        qmd: {
          extraCollections: [{ path: "~/agents/family/sessions", name: "family-sessions" }],
        },
      },
    },
    list: [
      {
        id: "main",
        workspace: "~/workspaces/main",
        memorySearch: {
          qmd: {
            extraCollections: [{ path: "notes" }], // 在工作区内解析 -> 集合名称 "notes-main"
          },
        },
      },
      { id: "family", workspace: "~/workspaces/family" },
    ],
  },
  memory: {
    backend: "qmd",
    qmd: { includeDefaultMemory: false },
  },
}
```

额外的集合路径可以在代理之间共享，但当路径在代理工作区外部时，集合名称保持明确。工作区内的路径保持代理作用域，因此每个代理保持自己的记录搜索集。

## 一个 WhatsApp 号码，多个人（DM 拆分）

您可以将**不同的 WhatsApp DM** 路由到不同的代理，同时保持在**一个 WhatsApp 账户**上。使用 `peer.kind: "direct"` 匹配发送者 E.164（如 `+15551234567`）。回复仍然来自同一个 WhatsApp 号码（没有每代理发送者身份）。

重要细节：直接聊天会折叠到代理的**主会话键**，因此真正的隔离需要**每人一个代理**。

示例：

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

注意：

- DM 访问控制是**每个 WhatsApp 账户全局**的（配对/允许列表），而不是每个代理的。
- 对于共享群组，将群组绑定到一个代理或使用 [广播群组](/channels/broadcast-groups)。

## 路由规则（消息如何选择代理）

绑定是**确定性**的，**最具体的获胜**：

1. `peer` 匹配（精确的 DM/群组/通道 ID）
2. `parentPeer` 匹配（线程继承）
3. `guildId + roles`（Discord 角色路由）
4. `guildId`（Discord）
5. `teamId`（Slack）
6. 通道的 `accountId` 匹配
7. 通道级匹配（`accountId: "*"`）
8. 回退到默认代理（`agents.list[].default`，否则第一个列表条目，默认：`main`）

如果在同一层级中有多个绑定匹配，配置顺序中的第一个获胜。如果绑定设置了多个匹配字段（例如 `peer` + `guildId`），则需要所有指定的字段（`AND` 语义）。

重要的账户范围细节：

- 省略 `accountId` 的绑定仅匹配默认账户。
- 使用 `accountId: "*"` 用于跨所有账户的通道范围回退。
- 如果您后来为同一个代理添加了具有显式账户 ID 的相同绑定，OpenClaw 会将现有的仅通道绑定升级为账户作用域，而不是复制它。

## 多个账户 / 电话号码

支持**多个账户**的通道（例如 WhatsApp）使用 `accountId` 来标识每个登录。每个 `accountId` 可以路由到不同的代理，因此一个服务器可以托管多个电话号码而不混合会话。

如果您希望在省略 `accountId` 时使用通道范围的默认账户，设置 `channels.<channel>.defaultAccount`（可选）。未设置时，OpenClaw 会回退到 `default`（如果存在），否则回退到第一个配置的账户 ID（已排序）。

支持此模式的常见通道包括：

- `whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`
- `irc`、`line`、`googlechat`、`mattermost`、`matrix`、`nextcloud-talk`
- `bluebubbles`、`zalo`、`zalouser`、`nostr`、`feishu`

## 概念

- `agentId`：一个"大脑"（工作区、每代理身份验证、每代理会话存储）。
- `accountId`：一个通道账户实例（例如 WhatsApp 账户 `"personal"` 与 `"biz"`）。
- `binding`：通过 `(channel, accountId, peer)` 以及可选的 guild/team ID 将入站消息路由到 `agentId`。
- 直接聊天折叠到 `agent:<agentId>:<mainKey>`（每代理"主"；`session.mainKey`）。

## 平台示例

### 每个代理的 Discord 机器人

每个 Discord 机器人账户映射到唯一的 `accountId`。将每个账户绑定到一个代理，并为每个机器人保持允许列表。

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "coding", workspace: "~/.openclaw/workspace-coding" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "discord", accountId: "default" } },
    { agentId: "coding", match: { channel: "discord", accountId: "coding" } },
  ],
  channels: {
    discord: {
      groupPolicy: "allowlist",
      accounts: {
        default: {
          token: "DISCORD_BOT_TOKEN_MAIN",
          guilds: {
            "123456789012345678": {
              channels: {
                "222222222222222222": { allow: true, requireMention: false },
              },
            },
          },
        },
        coding: {
          token: "DISCORD_BOT_TOKEN_CODING",
          guilds: {
            "123456789012345678": {
              channels: {
                "333333333333333333": { allow: true, requireMention: false },
              },
            },
          },
        },
      },
    },
  },
}
```

注意：

- 将每个机器人邀请到 guild 并启用消息内容意图。
- 令牌位于 `channels.discord.accounts.<id>.token`（默认账户可以使用 `DISCORD_BOT_TOKEN`）。

### 每个代理的 Telegram 机器人

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "alerts", workspace: "~/.openclaw/workspace-alerts" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "alerts", match: { channel: "telegram", accountId: "alerts" } },
  ],
  channels: {
    telegram: {
      accounts: {
        default: {
          botToken: "123456:ABC...",
          dmPolicy: "pairing",
        },
        alerts: {
          botToken: "987654:XYZ...",
          dmPolicy: "allowlist",
          allowFrom: ["tg:123456789"],
        },
      },
    },
  },
}
```

注意：

- 使用 BotFather 为每个代理创建一个机器人并复制每个令牌。
- 令牌位于 `channels.telegram.accounts.<id>.botToken`（默认账户可以使用 `TELEGRAM_BOT_TOKEN`）。

### 每个代理的 WhatsApp 号码

在启动网关之前链接每个账户：

```bash
openclaw channels login --channel whatsapp --account personal
openclaw channels login --channel whatsapp --account biz
```

`~/.openclaw/openclaw.json`（JSON5）：

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // 确定性路由：第一个匹配获胜（最具体的优先）。
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // 可选的每对等方覆盖（示例：将特定群组发送到工作代理）。
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // 默认关闭：代理到代理消息传递必须明确启用 + 允许列出。
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // 可选覆盖。默认：~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // 可选覆盖。默认：~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 示例：WhatsApp 日常聊天 + Telegram 深度工作

按通道拆分：将 WhatsApp 路由到快速日常代理，将 Telegram 路由到 Opus 代理。

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-6",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

注意：

- 如果您有通道的多个账户，在绑定中添加 `accountId`（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 要将单个 DM/群组路由到 Opus，同时将其余部分保留在 chat 上，为该对等方添加 `match.peer` 绑定；对等方匹配始终优于通道范围规则。

## 示例：相同通道，一个对等方到 Opus

保持 WhatsApp 在快速代理上，但将一个 DM 路由到 Opus：

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-6",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

对等方绑定始终获胜，因此将它们保持在通道范围规则之上。

## 绑定到 WhatsApp 群组的家庭代理

将专用家庭代理绑定到单个 WhatsApp 群组，带有提及门控和更严格的工具策略：

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

注意：

- 工具允许/拒绝列表是**工具**，不是技能。如果技能需要运行二进制文件，请确保 `exec` 被允许且二进制文件存在于沙箱中。
- 对于更严格的门控，设置 `agents.list[].groupChat.mentionPatterns` 并为通道启用群组允许列表。

## 每代理沙箱和工具配置

每个代理可以有自己的沙箱和工具限制：

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 个人代理无沙箱
        },
        // 无工具限制 - 所有工具可用
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 始终沙箱化
          scope: "agent",  // 每个代理一个容器
          docker: {
            // 容器创建后可选的一次性设置
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // 仅读工具
          deny: ["exec", "write", "edit", "apply_patch"],    // 拒绝其他
        },
      },
    ],
  },
}
```

注意：`setupCommand` 位于 `sandbox.docker` 下，在容器创建时运行一次。当解析的作用域为 `"shared"` 时，每代理 `sandbox.docker.*` 覆盖被忽略。

**好处：**

- **安全隔离**：限制不受信任代理的工具
- **资源控制**：沙箱特定代理，同时保持其他代理在主机上
- **灵活策略**：每代理不同的权限

注意：`tools.elevated` 是**全局**的，基于发送者；它不可按代理配置。如果您需要每代理边界，使用 `agents.list[].tools` 拒绝 `exec`。对于群组目标，使用 `agents.list[].groupChat.mentionPatterns`，以便 @提及清晰地映射到预期的代理。

请参阅 [多代理沙箱和工具](/tools/multi-agent-sandbox-tools) 了解详细示例。

## 相关

- [通道路由](/channels/channel-routing) — 消息如何路由到代理
- [子代理](/tools/subagents) — 生成后台代理运行
- [ACP 代理](/tools/acp-agents) — 运行外部编码测试工具
- [状态](/concepts/presence) — 代理状态和可用性
- [会话](/concepts/session) — 会话隔离和路由
