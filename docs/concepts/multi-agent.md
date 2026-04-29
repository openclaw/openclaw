---
summary: "多 Agent 路由：隔离的 Agent、渠道账户和绑定"
title: "多 Agent 路由"
sidebarTitle: "多 Agent 路由"
read_when: "您想要在一个 Gateway 进程中运行多个隔离的 Agent（工作区 + auth）。"
status: active
---

运行多个**隔离的** Agent —— 每个 Agent 有自己的工作区、状态目录（`agentDir`）和会话历史 —— 以及多个渠道账户（如两个 WhatsApp），全部在一个运行中的 Gateway 里。入站消息通过 bindings 路由到正确的 Agent。

这里的 **agent** 是完整的人设范围：工作区文件、auth profiles、模型注册表和会话存储。`agentDir` 是磁盘上的状态目录，位于 `~/.openclaw/agents/<agentId>/`，存放每个 Agent 的配置。**binding** 将渠道账户（如 Slack 工作区或 WhatsApp 号码）映射到其中一个 Agent。

## 什么是"一个 Agent"？

**Agent** 是一个完整作用域的大脑，有自己的：

- **工作区**（文件、AGENTS.md/SOUL.md/USER.md、本地笔记、persona 规则）。
- **状态目录**（`agentDir`）：用于 auth profiles、模型注册表和每个 Agent 的配置。
- **会话存储**（聊天历史 + 路由状态）：位于 `~/.openclaw/agents/<agentId>/sessions`。

Auth profiles 是**每个 Agent 独立的**。每个 Agent 从自己的位置读取：

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

<Note>
`sessions_history` 也是更安全的跨会话召回路径：它返回有限、受清理的视图，而不是原始 transcript 转储。Assistant 召回会剥离 thinking tags、`<relevant-memories>` 脚手架、纯文本 tool-call XML payloads（包括 `<tool_call>...</tool_call>`、`</minimax:tool_call>...</function_call>`、`<tool_calls>...</tool_calls>`、`<function_calls>...</function_calls>` 和截断的 tool-call blocks）、降级的 tool-call 脚手架、泄露的 ASCII/全角模型控制 tokens 和格式错误的 MiniMax tool-call XML，然后才进行 redact/truncation。
</Note>

<Warning>
Main agent 凭据**不会**自动共享。切勿跨 Agent 重用 `agentDir`（会导致 auth/session 冲突）。如果想共享凭据，将 `auth-profiles.json` 复制到其他 Agent 的 `agentDir`。
</Warning>

Skills 从每个 Agent 工作区以及 `~/.openclaw/skills` 等共享根目录加载，然后在配置时由有效的 Agent skill allowlist 过滤。使用 `agents.defaults.skills` 获取共享基线，使用 `agents.list[].skills` 进行每个 Agent 的替换。参见 [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills) 和 [Skills: agent skill allowlists](/tools/skills#agent-skill-allowlists)。

Gateway 可以托管**一个 Agent**（默认）或**多个 Agent** 并行。

<Note>
**工作区注意：** 每个 Agent 的工作区是**默认 cwd**，而不是硬 sandbox。相对路径在工作区内解析，但绝对路径可以访问其他主机位置（除非启用 sandboxing）。参见 [Sandboxing](/gateway/sandboxing)。
</Note>

## 路径（快速地图）

- Config: `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- State dir: `~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- Workspace: `~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- Agent dir: `~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- Sessions: `~/.openclaw/agents/<agentId>/sessions`

### 单 Agent 模式（默认）

如果不做任何操作，OpenClaw 运行单个 Agent：

- `agentId` 默认为 **`main`**。
- 会话 key 为 `agent:main:<mainKey>`。
- 工作区默认为 `~/.openclaw/workspace`（或设置 `OPENCLAW_PROFILE` 时为 `~/.openclaw/workspace-<profile>`）。
- 状态默认为 `~/.openclaw/agents/main/agent`。

## Agent 助手

使用向导添加新的隔离 Agent：

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
  <Step title="创建每个 Agent 工作区">
    使用向导或手动创建工作区：

    ```bash
    openclaw agents add coding
    openclaw agents add social
    ```

    每个 Agent 有自己的工作区，包含 `SOUL.md`、`AGENTS.md` 和可选的 `USER.md`，以及专用 `agentDir` 和会话存储，位于 `~/.openclaw/agents/<agentId>`。

  </Step>
  <Step title="创建渠道账户">
    在您喜欢的渠道上为每个 Agent 创建一个账户：

    - Discord：每个 Agent 一个 bot，启用 Message Content Intent，复制每个 token。
    - Telegram：通过 BotFather 每个 Agent 一个 bot，复制每个 token。
    - WhatsApp：每个账户链接每个电话号码。

    ```bash
    openclaw channels login --channel whatsapp --account work
    ```

    参见渠道指南：[Discord](/channels/discord)、[Telegram](/channels/telegram)、[WhatsApp](/channels/whatsapp)。

  </Step>
  <Step title="添加 Agent、账户和 bindings">
    在 `agents.list` 下添加 Agent，在 `channels.<channel>.accounts` 下添加渠道账户，并用 `bindings` 连接它们（示例如下）。
  </Step>
  <Step title="重启并验证">
    ```bash
    openclaw gateway restart
    openclaw agents list --bindings
    openclaw channels status --probe
    ```
  </Step>
</Steps>

## 多个 Agent = 多个人，多个人格

通过**多个 Agent**，每个 `agentId` 成为一个**完全隔离的人设**：

- **不同的电话号码/账户**（按渠道 `accountId`）。
- **不同的人格**（按 Agent 工作区文件如 `AGENTS.md` 和 `SOUL.md`）。
- **独立的 auth + 会话**（除非明确启用，否则不会交叉通信）。

这让**多个人**共享一个 Gateway 服务器，同时保持他们的 AI"大脑"和数据隔离。

## 跨 Agent QMD 内存搜索

如果一个 Agent 应该搜索另一个 Agent 的 QMD 会话 transcripts，在 `agents.list[].memorySearch.qmd.extraCollections` 下添加额外的集合。仅当每个 Agent 都应该继承相同的共享 transcript 集合时，使用 `agents.defaults.memorySearch.qmd.extraCollections`。

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

额外的集合路径可以在 Agent 间共享，但当路径在 Agent 工作区外时，集合名保持显式。工作区内的路径保持 Agent 作用域，这样每个 Agent 保留自己的 transcript 搜索集。

## 一个 WhatsApp 号码，多个人（DM 拆分）

您可以将**不同的 WhatsApp DM** 路由到不同的 Agent，同时保持在**一个 WhatsApp 账户**上。用 `peer.kind: "direct"` 匹配发送者 E.164（如 `+15551234567`）。回复仍来自同一个 WhatsApp 号码（没有每个 Agent 的发送者身份）。

<Note>
直接聊天合并到 Agent 的**主会话 key**，所以真正的隔离需要**每人一个 Agent**。
</Note>

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

- DM 访问控制是**每个 WhatsApp 账户全局的**（配对/allowlist），不是按 Agent 的。
- 对于共享群组，将群组绑定到一个 Agent 或使用 [Broadcast groups](/channels/broadcast-groups)。

## 路由规则（消息如何选择 Agent）

Bindings 是**确定性的**和**最具体优先**：

<Steps>
  <Step title="peer match">
    精确 DM/群组/渠道 ID。
  </Step>
  <Step title="parentPeer match">
    线程继承。
  </Step>
  <Step title="guildId + roles">
    Discord 角色路由。
  </Step>
  <Step title="guildId">
    Discord。
  </Step>
  <Step title="teamId">
    Slack。
  </Step>
  <Step title="accountId match for a channel">
    按账户的回退。
  </Step>
  <Step title="Channel-level match">
    `accountId: "*"`。
  </Step>
  <Step title="Default agent">
    回退到 `agents.list[].default`，否则为列表第一个条目，默认：`main`。
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="平局打破和 AND 语义">
    - 如果多个 bindings 在同一层级匹配，按配置顺序第一个获胜。
    - 如果 binding 设置了多个匹配字段（如 `peer` + `guildId`），则所有指定字段都需要匹配（`AND` 语义）。

  </Accordion>
  <Accordion title="账户作用域详情">
    - 省略 `accountId` 的 binding 只匹配默认账户。
    - 使用 `accountId: "*"` 进行跨所有账户的渠道级回退。
    - 如果稍后为同一 Agent 添加带有显式账户 ID 的相同 binding，OpenClaw 将现有渠道级 binding 升级为账户作用域，而不是重复它。

  </Accordion>
</AccordionGroup>

## 多账户/多号码

支持**多账户**的渠道（如 WhatsApp）使用 `accountId` 识别每个登录。每个 `accountId` 可以路由到不同的 Agent，所以一台服务器可以托管多个号码而不会混合会话。

如果您想要渠道级默认账户（当 `accountId` 被省略时），设置 `channels.<channel>.defaultAccount`（可选）。未设置时，OpenClaw 回退到 `default`（如果存在），否则为第一个配置的账户 ID（排序后）。

支持此模式的常见渠道包括：

- `whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`
- `irc`、`line`、`googlechat`、`mattermost`、`matrix`、`nextcloud-talk`
- `bluebubbles`、`zalo`、`zalouser`、`nostr`、`feishu`

## 概念

- `agentId`：一个"大脑"（工作区、每 Agent auth、每 Agent 会话存储）。
- `accountId`：一个渠道账户实例（如 WhatsApp 账户 `"personal"` vs `"biz"`）。
- `binding`：通过 `(channel, accountId, peer)` 以及可选的 guild/team IDs 将入站消息路由到 `agentId`。
- 直接聊天合并到 `agent:<agentId>:<mainKey>`（每 Agent "main"；`session.mainKey`）。

## 平台示例

<AccordionGroup>
  <Accordion title="每个 Agent 对应一个 Discord bot">
    每个 Discord bot 账户映射到唯一的 `accountId`。将每个账户绑定到一个 Agent 并保持每个 bot 的 allowlist。

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

    - 将每个 bot 邀请到 guild 并启用 Message Content Intent。
    - Token 位于 `channels.discord.accounts.<id>.token`（默认账户可使用 `DISCORD_BOT_TOKEN`）。

  </Accordion>
  <Accordion title="每个 Agent 对应一个 Telegram bot">
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

    - 通过 BotFather 为每个 Agent 创建一个 bot 并复制每个 token。
    - Token 位于 `channels.telegram.accounts.<id>.botToken`（默认账户可使用 `TELEGRAM_BOT_TOKEN`）。

  </Accordion>
  <Accordion title="每个 Agent 对应一个 WhatsApp 号码">
    启动 Gateway 前链接每个账户：

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

        // 可选的每-peer 覆盖（示例：将特定群组发送到 work agent）。
        {
          agentId: "work",
          match: {
            channel: "whatsapp",
            accountId: "personal",
            peer: { kind: "group", id: "1203630...@g.us" },
          },
        },
      ],

      // 默认关闭：Agent 间消息必须显式启用 + allowlist。
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

  </Accordion>
</AccordionGroup>

## 常见模式

<Tabs>
  <Tab title="WhatsApp 日常 + Telegram 深度工作">
    按渠道拆分：将 WhatsApp 路由到快速日常 Agent，将 Telegram 路由到 Opus Agent。

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

    - 如果您有一个渠道的多个账户，将 `accountId` 添加到 binding（如 `{ channel: "whatsapp", accountId: "personal" }`）。
    - 要将单个 DM/群组路由到 Opus 而保持其余在 chat 上，为该 peer 添加 `match.peer` binding；peer 匹配始终优于渠道级规则。

  </Tab>
  <Tab title="同一渠道，一个 peer 到 Opus">
    保持 WhatsApp 在快速 Agent 上，但将一个 DM 路由到 Opus：

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

    Peer bindings 始终优先，所以将它们放在渠道级规则之上。

  </Tab>
  <Tab title="Family Agent 绑定到 WhatsApp 群组">
    将专用 family Agent 绑定到单个 WhatsApp 群组，带提及门控和更严格的工具策略：

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

    - 工具 allow/deny 列表是**工具**，不是 skills。如果 skill 需要运行二进制文件，确保 `exec` 被允许且二进制文件存在于 sandbox 中。
    - 要更严格的门控，设置 `agents.list[].groupChat.mentionPatterns` 并保持渠道的群组 allowlist 启用。

  </Tab>
</Tabs>

## 每个 Agent 的 sandbox 和工具配置

每个 Agent 可以有自己的 sandbox 和工具限制：

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 个人 Agent 不使用 sandbox
        },
        // 没有工具限制 - 所有工具可用
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 始终 sandboxed
          scope: "agent",  // 每个 Agent 一个容器
          docker: {
            // 容器创建后可选的一次性设置
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

<Note>
`setupCommand` 位于 `sandbox.docker` 下，在容器创建时运行一次。当解析的 scope 为 `"shared"` 时，忽略每个 Agent 的 `sandbox.docker.*` 覆盖。
</Note>

**好处：**

- **安全隔离**：限制不受信任 Agent 的工具。
- **资源控制**：对特定 Agent sandboxed，同时保持其他在主机上。
- **灵活策略**：每个 Agent 不同权限。

<Note>
`tools.elevated` 是**全局的**且基于发送者；不能按 Agent 配置。如果您需要每个 Agent 边界，使用 `agents.list[].tools` 拒绝 `exec`。对于群组目标，使用 `agents.list[].groupChat.mentionPatterns` 以便 @mentions 干净地映射到目标 Agent。
</Note>

参见 [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools) 获取详细示例。

## 相关

- [ACP agents](/tools/acp-agents) — 运行外部编码 harness
- [Channel routing](/channels/channel-routing) — 消息如何路由到 Agent
- [Presence](/concepts/presence) — Agent 存在和可用性
- [Session](/concepts/session) — 会话隔离和路由
- [Sub-agents](/tools/subagents) — 生成后台 Agent 运行
