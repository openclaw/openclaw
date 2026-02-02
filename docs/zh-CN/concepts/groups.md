---
read_when:
  - 更改群聊行为或提及门控
summary: 跨平台的群聊行为（WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams）
title: 群组
x-i18n:
  generated_at: "2026-02-01T20:23:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b727a053edf51f6e7b5c0c324c2fc9c9789a9796c37f622418bd555e8b5a0ec4
  source_path: concepts/groups.md
  workflow: 14
---

# 群组

OpenClaw 在各平台上统一处理群聊：WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams。

## 入门简介（2 分钟）

OpenClaw "运行"在你自己的消息账户上。没有单独的 WhatsApp 机器人用户。
如果**你**在某个群组中，OpenClaw 就能看到该群组并在其中回复。

默认行为：

- 群组受限（`groupPolicy: "allowlist"`）。
- 除非你显式禁用提及门控，否则回复需要 @提及。

含义：允许列表中的发送者可以通过提及 OpenClaw 来触发它。

> 简而言之
>
> - **私聊访问**由 `*.allowFrom` 控制。
> - **群组访问**由 `*.groupPolicy` + 允许列表（`*.groups`、`*.groupAllowFrom`）控制。
> - **回复触发**由提及门控（`requireMention`、`/activation`）控制。

快速流程（群消息的处理过程）：

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![群消息流程](/images/groups-flow.svg)

如果你想要...
| 目标 | 需要设置的内容 |
|------|-------------|
| 允许所有群组但仅在 @提及时回复 | `groups: { "*": { requireMention: true } }` |
| 禁用所有群组回复 | `groupPolicy: "disabled"` |
| 仅特定群组 | `groups: { "<group-id>": { ... } }`（无 `"*"` 键） |
| 仅你可以在群组中触发 | `groupPolicy: "allowlist"`、`groupAllowFrom: ["+1555..."]` |

## 会话键

- 群组会话使用 `agent:<agentId>:<channel>:group:<id>` 会话键（房间/频道使用 `agent:<agentId>:<channel>:channel:<id>`）。
- Telegram 论坛主题会在群组 ID 后追加 `:topic:<threadId>`，使每个主题拥有独立的会话。
- 私聊使用主会话（或按发送者分配，如已配置）。
- 群组会话跳过心跳检测。

## 模式：个人私聊 + 公开群组（单智能体）

可以——如果你的"个人"流量是**私聊**，"公开"流量是**群组**，这种方式效果很好。

原因：在单智能体模式下，私聊通常落在**主**会话键（`agent:main:main`）上，而群组始终使用**非主**会话键（`agent:main:<channel>:group:<id>`）。如果你启用沙箱并设置 `mode: "non-main"`，这些群组会话将在 Docker 中运行，而你的主私聊会话留在主机上。

这为你提供了一个智能体"大脑"（共享工作区 + 记忆），但有两种执行姿态：

- **私聊**：完整工具（主机）
- **群组**：沙箱 + 受限工具（Docker）

> 如果你需要真正独立的工作区/角色（"个人"和"公开"绝不能混合），请使用第二个智能体 + 绑定。参见[多智能体路由](/concepts/multi-agent)。

示例（私聊在主机上，群组沙箱隔离 + 仅消息工具）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

想要"群组只能访问文件夹 X"而不是"无主机访问"？保持 `workspaceAccess: "none"` 并仅将允许的路径挂载到沙箱中：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

相关内容：

- 配置键和默认值：[Gateway网关配置](/gateway/configuration#agentsdefaultssandbox)
- 调试工具被阻止的原因：[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 绑定挂载详情：[沙箱隔离](/gateway/sandboxing#custom-bind-mounts)

## 显示标签

- UI 标签在可用时使用 `displayName`，格式为 `<channel>:<token>`。
- `#room` 保留给房间/频道；群聊使用 `g-<slug>`（小写，空格转为 `-`，保留 `#@+._-`）。

## 群组策略

按渠道控制群组/房间消息的处理方式：

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| 策略          | 行为                                  |
| ------------- | ------------------------------------- |
| `"open"`      | 群组绕过允许列表；提及门控仍然适用。  |
| `"disabled"`  | 完全阻止所有群组消息。                |
| `"allowlist"` | 仅允许匹配已配置允许列表的群组/房间。 |

注意事项：

- `groupPolicy` 与提及门控（要求 @提及）是分开的。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams：使用 `groupAllowFrom`（回退：显式 `allowFrom`）。
- Discord：允许列表使用 `channels.discord.guilds.<id>.channels`。
- Slack：允许列表使用 `channels.slack.channels`。
- Matrix：允许列表使用 `channels.matrix.groups`（房间 ID、别名或名称）。使用 `channels.matrix.groupAllowFrom` 限制发送者；也支持按房间的 `users` 允许列表。
- 群组私聊单独控制（`channels.discord.dm.*`、`channels.slack.dm.*`）。
- Telegram 允许列表可以匹配用户 ID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`）或用户名（`"@alice"` 或 `"alice"`）；前缀不区分大小写。
- 默认为 `groupPolicy: "allowlist"`；如果你的群组允许列表为空，群组消息将被阻止。

快速心智模型（群消息的评估顺序）：

1. `groupPolicy`（open/disabled/allowlist）
2. 群组允许列表（`*.groups`、`*.groupAllowFrom`、渠道特定的允许列表）
3. 提及门控（`requireMention`、`/activation`）

## 提及门控（默认）

群消息需要提及才能触发，除非按群组覆盖。默认值位于 `*.groups."*"` 下的各子系统中。

回复机器人消息视为隐式提及（当渠道支持回复元数据时）。这适用于 Telegram、WhatsApp、Slack、Discord 和 Microsoft Teams。

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

注意事项：

- `mentionPatterns` 是不区分大小写的正则表达式。
- 提供原生提及的平台仍然通过；模式匹配是备用方案。
- 按智能体覆盖：`agents.list[].groupChat.mentionPatterns`（多个智能体共享一个群组时很有用）。
- 提及门控仅在可以检测提及时生效（原生提及或已配置 `mentionPatterns`）。
- Discord 默认值位于 `channels.discord.guilds."*"` 中（可按服务器/频道覆盖）。
- 群组历史上下文在各渠道中统一包装，且为**仅待处理**（因提及门控跳过的消息）；使用 `messages.groupChat.historyLimit` 设置全局默认值，使用 `channels.<channel>.historyLimit`（或 `channels.<channel>.accounts.*.historyLimit`）进行覆盖。设为 `0` 以禁用。

## 群组/频道工具限制（可选）

某些渠道配置支持限制**特定群组/房间/频道内**可用的工具。

- `tools`：为整个群组允许/拒绝工具。
- `toolsBySender`：群组内按发送者覆盖（键为发送者 ID/用户名/邮箱/电话号码，取决于渠道）。使用 `"*"` 作为通配符。

解析顺序（最具体的优先）：

1. 群组/频道 `toolsBySender` 匹配
2. 群组/频道 `tools`
3. 默认（`"*"`）`toolsBySender` 匹配
4. 默认（`"*"`）`tools`

示例（Telegram）：

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

注意事项：

- 群组/频道工具限制在全局/智能体工具策略之上额外应用（拒绝仍然优先）。
- 某些渠道对房间/频道使用不同的嵌套结构（例如 Discord `guilds.*.channels.*`、Slack `channels.*`、Microsoft Teams `teams.*.channels.*`）。

## 群组允许列表

当配置了 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 时，键充当群组允许列表。使用 `"*"` 允许所有群组，同时仍可设置默认提及行为。

常见意图（可直接复制粘贴）：

1. 禁用所有群组回复

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 仅允许特定群组（WhatsApp）

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. 允许所有群组但要求提及（显式）

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 仅所有者可以在群组中触发（WhatsApp）

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## 激活（仅所有者）

群组所有者可以切换按群组的激活方式：

- `/activation mention`
- `/activation always`

所有者由 `channels.whatsapp.allowFrom` 确定（未设置时使用机器人自身的 E.164 号码）。以独立消息发送该命令。其他平台目前忽略 `/activation`。

## 上下文字段

群组入站消息负载设置：

- `ChatType=group`
- `GroupSubject`（如已知）
- `GroupMembers`（如已知）
- `WasMentioned`（提及门控结果）
- Telegram 论坛主题还包含 `MessageThreadId` 和 `IsForum`。

智能体系统提示词在新群组会话的首轮包含群组简介。它提醒模型像人一样回复，避免 Markdown 表格，避免输入字面的 `\n` 序列。

## iMessage 特定说明

- 路由或添加允许列表时优先使用 `chat_id:<id>`。
- 列出聊天：`imsg chats --limit 20`。
- 群组回复始终返回到同一个 `chat_id`。

## WhatsApp 特定说明

有关 WhatsApp 专有行为（历史注入、提及处理详情），请参阅[群消息](/concepts/group-messages)。
