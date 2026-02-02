---
read_when: 你希望在一个 Gateway网关进程中运行多个隔离的智能体（工作区 + 认证）。
status: active
summary: 多智能体路由：隔离的智能体、渠道账户和绑定
title: 多智能体路由
x-i18n:
  generated_at: "2026-02-01T20:23:55Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1848266c632cd6c96ff99ea9eb9c17bbfe6d35fa1f90450853083e7c548d5324
  source_path: concepts/multi-agent.md
  workflow: 14
---

# 多智能体路由

目标：在一个运行中的 Gateway网关中托管多个*隔离的*智能体（独立的工作区 + `agentDir` + 会话），以及多个渠道账户（例如两个 WhatsApp）。入站消息通过绑定路由到对应的智能体。

## 什么是"一个智能体"？

一个**智能体**是一个完全独立作用域的大脑，拥有自己的：

- **工作区**（文件、AGENTS.md/SOUL.md/USER.md、本地笔记、人设规则）。
- **状态目录**（`agentDir`），用于存储认证配置文件、模型注册表和按智能体配置。
- **会话存储**（聊天历史 + 路由状态），位于 `~/.openclaw/agents/<agentId>/sessions`。

认证配置文件是**按智能体隔离的**。每个智能体从自己的目录读取：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

主智能体的凭证**不会**自动共享。切勿在智能体之间复用 `agentDir`（会导致认证/会话冲突）。如果你想共享凭证，请将 `auth-profiles.json` 复制到另一个智能体的 `agentDir` 中。

Skills 通过每个工作区的 `skills/` 文件夹按智能体隔离，共享 Skills 可从 `~/.openclaw/skills` 获取。参阅[Skills：按智能体 vs 共享](/tools/skills#per-agent-vs-shared-skills)。

Gateway网关可以托管**一个智能体**（默认）或**多个智能体**并行运行。

**工作区说明：** 每个智能体的工作区是**默认工作目录**，而非严格的沙箱。相对路径在工作区内解析，但绝对路径可以访问主机上的其他位置，除非启用了沙箱。参阅[沙箱](/gateway/sandboxing)。

## 路径（速查）

- 配置文件：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- 状态目录：`~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- 工作区：`~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- 智能体目录：`~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- 会话：`~/.openclaw/agents/<agentId>/sessions`

### 单智能体模式（默认）

如果你不做任何配置，OpenClaw 会运行单个智能体：

- `agentId` 默认为 **`main`**。
- 会话键格式为 `agent:main:<mainKey>`。
- 工作区默认为 `~/.openclaw/workspace`（设置了 `OPENCLAW_PROFILE` 时为 `~/.openclaw/workspace-<profile>`）。
- 状态默认为 `~/.openclaw/agents/main/agent`。

## 智能体助手

使用智能体向导添加新的隔离智能体：

```bash
openclaw agents add work
```

然后添加 `bindings`（或让向导完成）来路由入站消息。

验证方式：

```bash
openclaw agents list --bindings
```

## 多智能体 = 多用户、多人设

使用**多个智能体**时，每个 `agentId` 都成为一个**完全隔离的人设**：

- **不同的手机号/账户**（按渠道 `accountId`）。
- **不同的性格**（按智能体工作区文件，如 `AGENTS.md` 和 `SOUL.md`）。
- **独立的认证 + 会话**（除非显式启用，否则无串扰）。

这使得**多个用户**可以共享一台 Gateway网关服务器，同时保持各自的 AI "大脑"和数据隔离。

## 一个 WhatsApp 号码，多个用户（私聊分流）

你可以将**不同的 WhatsApp 私聊**路由到不同的智能体，同时使用**同一个 WhatsApp 账户**。通过发送者的 E.164 格式号码（如 `+15551234567`）配合 `peer.kind: "dm"` 进行匹配。回复仍然从同一个 WhatsApp 号码发出（没有按智能体的发送者身份）。

重要细节：私聊会折叠到智能体的**主会话键**，因此真正的隔离需要**每人一个智能体**。

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
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

说明：

- 私聊访问控制是**按 WhatsApp 账户全局的**（配对/白名单），而非按智能体。
- 对于共享群组，将群组绑定到一个智能体或使用[广播群组](/broadcast-groups)。

## 路由规则（消息如何选择智能体）

绑定是**确定性的**，遵循**最精确匹配优先**原则：

1. `peer` 匹配（精确的私聊/群组/渠道 ID）
2. `guildId`（Discord）
3. `teamId`（Slack）
4. `accountId` 匹配（按渠道）
5. 渠道级匹配（`accountId: "*"`）
6. 回退到默认智能体（`agents.list[].default`，否则取列表第一项，默认值：`main`）

## 多账户/多手机号

支持**多账户**的渠道（如 WhatsApp）使用 `accountId` 来标识每个登录。每个 `accountId` 可以路由到不同的智能体，这样一台服务器就可以托管多个手机号而不会混淆会话。

## 概念

- `agentId`：一个"大脑"（工作区、按智能体认证、按智能体会话存储）。
- `accountId`：一个渠道账户实例（例如 WhatsApp 账户 `"personal"` vs `"biz"`）。
- `binding`：通过 `(channel, accountId, peer)` 以及可选的 guild/team ID 将入站消息路由到 `agentId`。
- 私聊折叠到 `agent:<agentId>:<mainKey>`（按智能体的"主会话"；`session.mainKey`）。

## 示例：两个 WhatsApp → 两个智能体

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

  // 确定性路由：第一个匹配生效（最精确的在前）。
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // 可选的按对端覆盖（示例：将特定群组发送到 work 智能体）。
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // 默认关闭：智能体间消息传递必须显式启用 + 白名单。
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
          // 可选覆盖。默认值：~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // 可选覆盖。默认值：~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 示例：WhatsApp 日常聊天 + Telegram 深度工作

按渠道分流：将 WhatsApp 路由到快速日常智能体，将 Telegram 路由到 Opus 智能体。

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-5",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

说明：

- 如果一个渠道有多个账户，请在绑定中添加 `accountId`（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 要将单个私聊/群组路由到 Opus 而其余保持在 chat 上，请为该对端添加 `match.peer` 绑定；对端匹配始终优先于渠道级规则。

## 示例：同一渠道，将一个对端路由到 Opus

将 WhatsApp 保持在快速智能体上，但将一个私聊路由到 Opus：

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-5",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

对端绑定始终优先，因此请将它们放在渠道级规则之上。

## 绑定到 WhatsApp 群组的家庭智能体

将一个专用家庭智能体绑定到单个 WhatsApp 群组，使用提及控制和更严格的工具策略：

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

说明：

- 工具允许/拒绝列表针对的是**工具**，而非 Skills。如果某个 Skills 需要运行二进制文件，请确保允许 `exec` 并且该二进制文件存在于沙箱中。
- 要实现更严格的控制，请设置 `agents.list[].groupChat.mentionPatterns` 并为渠道启用群组白名单。

## 按智能体的沙箱和工具配置

从 v2026.1.6 开始，每个智能体可以有自己的沙箱和工具限制：

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 个人智能体不使用沙箱
        },
        // 无工具限制 - 所有工具可用
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 始终沙箱隔离
          scope: "agent",  // 每个智能体一个容器
          docker: {
            // 容器创建后的可选一次性设置
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // 仅允许 read 工具
          deny: ["exec", "write", "edit", "apply_patch"],    // 拒绝其他工具
        },
      },
    ],
  },
}
```

注意：`setupCommand` 位于 `sandbox.docker` 下，在容器创建时运行一次。当解析的 scope 为 `"shared"` 时，按智能体的 `sandbox.docker.*` 覆盖会被忽略。

**优势：**

- **安全隔离**：限制不受信任的智能体的工具
- **资源控制**：沙箱隔离特定智能体，同时让其他智能体在主机上运行
- **灵活策略**：按智能体设置不同权限

注意：`tools.elevated` 是**全局的**且基于发送者；不能按智能体配置。如果你需要按智能体的边界，请使用 `agents.list[].tools` 来拒绝 `exec`。对于群组定向，请使用 `agents.list[].groupChat.mentionPatterns`，以便 @提及能准确映射到目标智能体。

参阅[多智能体沙箱与工具](/multi-agent-sandbox-tools)获取详细示例。
