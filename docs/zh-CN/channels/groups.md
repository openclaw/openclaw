---
read_when:
  - 更改群聊行为或提及限制
summary: 跨平台的群聊行为（WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams）
title: 群组
x-i18n:
  generated_at: "2026-02-03T07:47:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b727a053edf51f6e7b5c0c324c2fc9c9789a9796c37f622418bd555e8b5a0ec4
  source_path: channels/groups.md
  workflow: 15
---

# 群组

OpenClaw 在各平台上统一处理群聊：WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams。

## 新手入门（2 分钟）

OpenClaw"运行"在你自己的消息账户上。没有单独的 WhatsApp 机器人用户。如果**你**在一个群组中，OpenClaw 就可以看到该群组并在其中回复。

默认行为：

- 群组受限（`groupPolicy: "allowlist"`）。
- 除非你明确禁用提及限制，否则回复需要 @ 提及。

解释：允许列表中的发送者可以通过提及来触发 OpenClaw。

> 简而言之
>
> - **私信访问**由 `*.allowFrom` 控制。
> - **群组访问**由 `*.groupPolicy` + 允许列表（`*.groups`、`*.groupAllowFrom`）控制。
> - **回复触发**由提及限制（`requireMention`、`/activation`）控制。

快速流程（群消息会发生什么）：

```
groupPolicy? disabled -> 丢弃
groupPolicy? allowlist -> 群组允许? 否 -> 丢弃
requireMention? 是 -> 被提及? 否 -> 仅存储为上下文
否则 -> 回复
```

![群消息流程](/images/groups-flow.svg)

如果你想...
| 目标 | 设置什么 |
|------|-------------|
| 允许所有群组但仅在 @ 提及时回复 | `groups: { "*": { requireMention: true } }` |
| 禁用所有群组回复 | `groupPolicy: "disabled"` |
| 仅特定群组 | `groups: { "<group-id>": { ... } }`（无 `"*"` 键） |
| 仅你可以在群组中触发 | `groupPolicy: "allowlist"`、`groupAllowFrom: ["+1555..."]` |

## 会话键

- 群组会话使用 `agent:<agentId>:<channel>:group:<id>` 会话键（房间/频道使用 `agent:<agentId>:<channel>:channel:<id>`）。
- Telegram 论坛话题在群组 ID 后添加 `:topic:<threadId>`，因此每个话题都有自己的会话。
- 私聊使用主会话（或按发送者配置时使用各自的会话）。
- 群组会话跳过心跳。

## 模式：个人私信 + 公开群组（单智能体）

是的——如果你的"个人"流量是**私信**而"公开"流量是**群组**，这种方式效果很好。

原因：在单智能体模式下，私信通常落在**主**会话键（`agent:main:main`）中，而群组始终使用**非主**会话键（`agent:main:<channel>:group:<id>`）。如果你启用 `mode: "non-main"` 的沙箱隔离，这些群组会话在 Docker 中运行，而你的主私信会话保持在主机上。

这给你一个智能体"大脑"（共享工作区 + 记忆），但两种执行姿态：

- **私信**：完整工具（主机）
- **群组**：沙箱 + 受限工具（Docker）

> 如果你需要真正独立的工作区/角色（"个人"和"公开"绝不能混合），请使用第二个智能体 + 绑定。参见[多智能体路由](/concepts/multi-agent)。

示例（私信在主机上，群组沙箱隔离 + 仅消息工具）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // 群组/频道是非主 -> 沙箱隔离
        scope: "session", // 最强隔离（每个群组/频道一个容器）
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // 如果 allow 非空，其他所有工具都被阻止（deny 仍然优先）。
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

想要"群组只能看到文件夹 X"而不是"无主机访问"？保持 `workspaceAccess: "none"` 并仅将允许的路径挂载到沙箱中：

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

相关：

- 配置键和默认值：[Gateway 网关配置](/gateway/configuration#agentsdefaultssandbox)
- 调试为什么工具被阻止：[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 绑定挂载详情：[沙箱隔离](/gateway/sandboxing#custom-bind-mounts)

## 显示标签

- UI 标签在可用时使用 `displayName`，格式为 `<channel>:<token>`。
- `#room` 保留用于房间/频道；群聊使用 `g-<slug>`（小写，空格 -> `-`，保留 `#@+._-`）。

## 群组策略

控制每个渠道如何处理群组/房间消息：

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

| 策略          | 行为                                    |
| ------------- | --------------------------------------- |
| `"open"`      | 群组绕过允许列表；提及限制仍然适用。    |
| `"disabled"`  | 完全阻止所有群组消息。                  |
| `"allowlist"` | 仅允许与配置的允许列表匹配的群组/房间。 |

注意事项：

- `groupPolicy` 与提及限制（需要 @ 提及）是分开的。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams：使用 `groupAllowFrom`（回退：显式 `allowFrom`）。
- Discord：允许列表使用 `channels.discord.guilds.<id>.channels`。
- Slack：允许列表使用 `channels.slack.channels`。
- Matrix：允许列表使用 `channels.matrix.groups`（房间 ID、别名或名称）。使用 `channels.matrix.groupAllowFrom` 限制发送者；也支持每个房间的 `users` 允许列表。
- 群组私信单独控制（`channels.discord.dm.*`、`channels.slack.dm.*`）。
- Telegram 允许列表可以匹配用户 ID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`）或用户名（`"@alice"` 或 `"alice"`）；前缀不区分大小写。
- 默认为 `groupPolicy: "allowlist"`；如果你的群组允许列表为空，群组消息将被阻止。

快速心智模型（群组消息的评估顺序）：

1. `groupPolicy`（open/disabled/allowlist）
2. 群组允许列表（`*.groups`、`*.groupAllowFrom`、渠道特定允许列表）
3. 提及限制（`requireMention`、`/activation`）

## 提及限制（默认）

群组消息需要提及，除非按群组覆盖。默认值位于 `*.groups."*"` 下的每个子系统中。

回复机器人消息被视为隐式提及（当渠道支持回复元数据时）。这适用于 Telegram、WhatsApp、Slack、Discord 和 Microsoft Teams。

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
- 提供显式提及的平台仍然通过；模式是回退。
- 每个智能体覆盖：`agents.list[].groupChat.mentionPatterns`（当多个智能体共享一个群组时有用）。
- 提及限制仅在提及检测可行时强制执行（原生提及或 `mentionPatterns` 已配置）。
- Discord 默认值位于 `channels.discord.guilds."*"`（可按服务器/频道覆盖）。
- 群组历史上下文在渠道间统一包装，并且是**仅待处理**（由于提及限制而跳过的消息）；使用 `messages.groupChat.historyLimit` 作为全局默认值，使用 `channels.<channel>.historyLimit`（或 `channels.<channel>.accounts.*.historyLimit`）进行覆盖。设置 `0` 以禁用。

## 群组/频道工具限制（可选）

某些渠道配置支持限制**特定群组/房间/频道内**可用的工具。

- `tools`：为整个群组允许/拒绝工具。
- `toolsBySender`：群组内的按发送者覆盖（键是发送者 ID/用户名/邮箱/电话号码，取决于渠道）。使用 `"*"` 作为通配符。

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

- 群组/频道工具限制在全局/智能体工具策略之外额外应用（deny 仍然优先）。
- 某些渠道对房间/频道使用不同的嵌套结构（例如，Discord `guilds.*.channels.*`、Slack `channels.*`、MS Teams `teams.*.channels.*`）。

## 群组允许列表

当配置了 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 时，键作为群组允许列表。使用 `"*"` 允许所有群组，同时仍设置默认提及行为。

常见意图（复制/粘贴）：

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

3. 允许所有群组但需要提及（显式）

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

群组所有者可以切换每个群组的激活状态：

- `/activation mention`
- `/activation always`

所有者由 `channels.whatsapp.allowFrom` 确定（未设置时为机器人自身的 E.164）。将命令作为独立消息发送。其他平台目前忽略 `/activation`。

## 上下文字段

群组入站负载设置：

- `ChatType=group`
- `GroupSubject`（如果已知）
- `GroupMembers`（如果已知）
- `WasMentioned`（提及限制结果）
- Telegram 论坛话题还包括 `MessageThreadId` 和 `IsForum`。

智能体系统提示在新群组会话的第一轮包含群组介绍。它提醒模型像人类一样回复，避免 Markdown 表格，避免输入字面量 `\n` 序列。

## iMessage 特定内容

- 路由或允许列表时优先使用 `chat_id:<id>`。
- 列出聊天：`imsg chats --limit 20`。
- 群组回复始终返回到相同的 `chat_id`。

## WhatsApp 特定内容

参见[群消息](/channels/group-messages)了解 WhatsApp 专有行为（历史注入、提及处理详情）。
