---
summary: "多代理路由：隔离的代理、频道账户和绑定"
title: 多代理路由
read_when: "您希望在一个网关进程中运行多个隔离的代理（工作区 + 认证）。"
status: active
---

# 多代理路由

目标：在一个运行的网关中运行多个**隔离**的代理（独立工作区 + `agentDir` + 会话），以及多个频道账户（例如两个 WhatsApp）。入站消息通过绑定路由到代理。

## 什么是"一个代理"？

**代理**是一个完全作用域的大脑，拥有自己的：

- **工作区**（文件、AGENTS.md/SOUL.md/USER.md、本地笔记、角色规则）。
- **状态目录**（`agentDir`）用于认证配置文件、模型注册表和每个代理的配置。
- **会话存储**（聊天历史 + 路由状态）位于 `~/.openclaw/agents/<agentId>/sessions`。

认证配置文件是**每个代理**的。每个代理从自己的：

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

读取。

`sessions_history` 在这里也是更安全的跨会话回忆路径：它返回一个有界的、经过清理的视图，而不是原始记录转储。助手回忆在编辑/截断之前会剥离思考标签、`<relevant-memories>` 脚手架、纯文本工具调用 XML 有效负载（包括 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>`、`<function_calls>...</function_calls>` 和截断的工具调用块）、降级的工具调用脚手架、泄露的 ASCII/全宽模型控制令牌以及格式错误的 MiniMax 工具调用 XML。

主代理凭证**不会**自动共享。永远不要跨代理重用 `agentDir`（这会导致认证/会话冲突）。如果您想共享凭证，请将 `auth-profiles.json` 复制到其他代理的 `agentDir` 中。

技能从每个代理工作区加载，加上共享根（如 `~/.openclaw/skills`），然后在配置时按有效代理技能允许列表过滤。使用 `agents.defaults.skills` 作为共享基线，使用 `agents.list[].skills` 作为每个代理的替换。请参阅 [技能：每个代理 vs 共享](/tools/skills#per-agent-vs-shared-skills) 和 [技能：代理技能允许列表](/tools/skills#agent-skill-allowlists)。

网关可以托管**一个代理**（默认）或**多个代理**并排运行。

**工作区注意：** 每个代理的工作区是**默认当前工作目录**，不是硬沙箱。相对路径在工作区内解析，但绝对路径可以到达其他主机位置，除非启用了沙箱。请参阅 [沙箱](/gateway/sandboxing)。

## 路径（快速映射）

- 配置：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- 状态目录：`~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- 工作区：`~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- 代理目录：`~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- 会话：`~/.openclaw/agents/<agentId>/sessions`

### 单代理模式（默认）

如果您什么都不做，OpenClaw 运行一个单一代理：

- `agentId` 默认**`main`**。
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

## 快速入门

<Steps>
  <Step title="创建每个代理工作区">

使用向导或手动创建工作区：

```bash
openclaw agents add coding
openclaw agents add social
```

每个代理获得自己的工作区，包含 `SOUL.md`、`AGENTS.md` 和可选的 `USER.md`，以及专用的 `agentDir` 和会话存储，位于 `~/.openclaw/agents/<agentId>` 下。

  </Step>

  <Step title="创建频道账户">

在您首选的频道上为每个代理创建一个账户：

- Discord：每个代理一个机器人，启用消息内容意图，复制每个令牌。
- Telegram：通过 BotFather 为每个代理创建一个机器人，复制每个令牌。
- WhatsApp：为每个账户链接每个电话号码。

```bash
openclaw channels login --channel whatsapp --account work
```

请参阅频道指南：[Discord](/channels/discord)、[Telegram](/channels/telegram)、[WhatsApp](/channels/whatsapp)。

  </Step>

  <Step title="添加代理、账户和绑定">

在 `agents.list` 下添加代理，在 `channels.<channel>.accounts` 下添加频道账户，并使用 `bindings` 连接它们（示例如下）。

  </Step>

  <Step title="重启并验证">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

  </Step>
</Steps>

## 多个代理 = 多个人、多个个性

使用**多个代理**，每个 `agentId` 成为一个**完全隔离的角色**：

- **不同的电话号码/账户**（每个频道 `accountId`）。
- **不同的个性**（每个代理工作区文件，如 `AGENTS.md` 和 `SOUL.md`）。
- **独立的认证 + 会话**（除非明确启用，否则无交叉通信）。

这允许多个人共享一个网关服务器，同时保持他们的 AI "大脑" 和数据隔离。

## 跨代理 QMD 记忆搜索

如果一个代理应该搜索另一个代理的 QMD 会话记录，请在 `agents.list[].memorySearch.qmd.extraCollections` 下添加额外集合。仅当每个代理都应该继承相同的共享记录集合时，才使用 `agents.defaults.memorySearch.qmd.extraCollections`。

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
            extraCollections: [{ path: "notes" }], // 在工作区内解析 -> 集合名为 "notes-main"
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

额外集合路径可以跨代理共享，但当路径在代理工作区之外时，集合名称保持显式。工作区内的路径保持代理作用域，因此每个代理保持自己的记录搜索集。

## 一个 WhatsApp 号码，多个人（DM 分割）

您可以将**不同的 WhatsApp DM** 路由到不同的代理，同时保持在**一个 WhatsApp 账户**上。使用 `peer.kind: "direct"` 匹配发送者 E.164（如 `+15551234567`）。回复仍然来自同一个 WhatsApp 号码（没有每个代理的发送者身份）。

重要细节：直接聊天折叠到代理的**主会话键**，因此真正的隔离需要**每人一个代理**。

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

- DM 访问控制是**每个 WhatsApp 账户全局**的（配对/允许列表），不是每个代理的。
- 对于共享群组，将群组绑定到一个代理或使用 [广播群组](/channels/broadcast-groups)。

## 路由规则（消息如何选择代理）

绑定是**确定性的**，**最具体的获胜**：

1. `peer` 匹配（精确的 DM/群组/频道 ID）
2. `parentPeer` 匹配（线程继承）
3. `guildId + roles`（Discord 角色路由）
4. `guildId`（Discord）
5. `teamId`（Slack）
6. 频道的 `accountId` 匹配
7. 频道级匹配（`accountId: "*"`）
8. 回退到默认代理（`agents.list[].default`，否则列表的第一个条目，默认：`main`）

如果在同一层级有多个绑定匹配，配置顺序中的第一个获胜。
如果绑定设置了多个匹配字段（例如 `peer` + `guildId`），所有指定的字段都是必需的（`AND` 语义）。

重要的账户范围细节：

- 省略 `accountId` 的绑定仅匹配默认账户。
- 使用 `accountId: "*"` 用于跨所有账户的频道范围回退。
- 如果您后来为同一个代理添加了具有显式账户 ID 的相同绑定，OpenClaw 会将现有的仅频道绑定升级为账户作用域，而不是复制它。

## 多个账户 / 电话号码

支持**多个账户**的频道（例如 WhatsApp）使用 `accountId` 来标识每个登录。每个 `accountId` 可以路由到不同的代理，因此一个服务器可以托管多个电话号码而不混合会话。

如果您希望在省略 `accountId` 时使用频道范围的默认账户，请设置 `channels.<channel>.defaultAccount`（可选）。未设置时，OpenClaw 回退到 `default`（如果存在），否则为第一个配置的账户 ID（已排序）。

支持此模式的常见频道包括：

- `whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`
- `irc`、`line`、`googlechat`、`mattermost`、`matrix`、`nextcloud-talk`
- `bluebubbles`、`zalo`、`zalouser`、`nostr`、`feishu`

## 概念

- `agentId`：一个 "大脑"（工作区、每个代理认证、每个代理会话存储）。
- `accountId`：一个频道账户实例（例如 WhatsApp 账户 `"personal"` vs `"biz"`）。
- `binding`：通过 `(channel, accountId, peer)` 以及可选的 guild/team ID 将入站消息路由到 `agentId`。
- 直接聊天折叠到 `agent:<agentId>:<mainKey>`（每个代理的 "main"；`session.mainKey`）。

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

- 邀请每个机器人到公会并启用消息内容意图。
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

    // 可选的每个对等方覆盖（例如：将特定群组发送到工作代理）。
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // 默认关闭：代理到代理消息必须明确启用 + 允许列表。
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

按频道分割：将 WhatsApp 路由到快速的日常代理，将 Telegram 路由到 Opus 代理。

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

- 如果您为一个频道有多个账户，请将 `accountId` 添加到绑定中（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 要将单个 DM/群组路由到 Opus，同时保持其余的在 chat 上，请为该对等方添加 `match.peer` 绑定；对等方匹配始终优先于频道范围规则。

## 示例：相同频道，一个对等方到 Opus

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

对等方绑定始终获胜，因此将它们保持在频道范围规则之上。

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

- 工具允许/拒绝列表是**工具**，不是技能。如果技能需要运行二进制文件，请确保 `exec` 被允许并且二进制文件存在于沙箱中。
- 对于更严格的门控，设置 `agents.list[].groupChat.mentionPatterns` 并为频道启用群组允许列表。

## 每个代理的沙箱和工具配置

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
          mode: "all",     // 始终沙箱
          scope: "agent",  // 每个代理一个容器
          docker: {
            // 容器创建后的可选一次性设置
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // 仅 read 工具
          deny: ["exec", "write", "edit", "apply_patch"],    // 拒绝其他
        },
      },
    ],
  },
}
```

注意：`setupCommand` 位于 `sandbox.docker` 下，在容器创建时运行一次。当解析的作用域为 `"shared"` 时，每个代理的 `sandbox.docker.*` 覆盖被忽略。

**好处：**

- **安全隔离**：限制不受信任代理的工具
- **资源控制**：沙箱特定代理，同时保持其他代理在主机上
- **灵活策略**：每个代理不同的权限

注意：`tools.elevated` 是**全局**的且基于发送者；它不可按代理配置。如果您需要每个代理的边界，请使用 `agents.list[].tools` 拒绝 `exec`。对于群组目标，使用 `agents.list[].groupChat.mentionPatterns` 以便 @提及干净地映射到预期的代理。

请参阅 [多代理沙箱和工具](/tools/multi-agent-sandbox-tools) 了解详细示例。

## 相关

- [频道路由](/channels/channel-routing) — 消息如何路由到代理
- [子代理](/tools/subagents) — 生成后台代理运行
- [ACP 代理](/tools/acp-agents) — 运行外部编码工具
- [存在](/concepts/presence) — 代理存在和可用性
- [会话](/concepts/session) — 会话隔离和路由