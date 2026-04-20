---
summary: "跨平台（Discord/iMessage/Matrix/Microsoft Teams/Signal/Slack/Telegram/WhatsApp/Zalo）的群组聊天行为"
read_when:
  - 更改群组聊天行为或提及门控
title: "群组"
---

# 群组

OpenClaw 在所有平台上一致地处理群组聊天：Discord、iMessage、Matrix、Microsoft Teams、Signal、Slack、Telegram、WhatsApp、Zalo。

## 初学者介绍（2分钟）

OpenClaw “生活”在你自己的消息账户上。没有单独的 WhatsApp 机器人用户。
如果你在群组中，OpenClaw 可以看到该群组并在那里响应。

默认行为：

- 群组是受限制的（`groupPolicy: "allowlist"`）。
- 除非你明确禁用提及门控，否则回复需要提及。

翻译：允许列表中的发送者可以通过提及来触发 OpenClaw。

> 简要总结
>
> - **DM 访问**由 `*.allowFrom` 控制。
> - **群组访问**由 `*.groupPolicy` + 允许列表（`*.groups`、`*.groupAllowFrom`）控制。
> - **回复触发**由提及门控（`requireMention`、`/activation`）控制。

快速流程（群组消息会发生什么）：

```
groupPolicy? disabled -> 丢弃
groupPolicy? allowlist -> 群组允许？否 -> 丢弃
requireMention? yes -> 被提及？否 -> 仅存储为上下文
否则 -> 回复
```

## 上下文可见性和允许列表

群组安全涉及两个不同的控制：

- **触发授权**：谁可以触发代理（`groupPolicy`、`groups`、`groupAllowFrom`、通道特定的允许列表）。
- **上下文可见性**：哪些补充上下文被注入到模型中（回复文本、引用、线程历史、转发元数据）。

默认情况下，OpenClaw 优先考虑正常的聊天行为，并保持上下文基本不变。这意味着允许列表主要决定谁可以触发操作，而不是对每个引用或历史片段的通用编辑边界。

当前行为是通道特定的：

- 一些通道已经在特定路径中对补充上下文应用基于发送者的过滤（例如 Slack 线程种子、Matrix 回复/线程查找）。
- 其他通道仍然按原样传递引用/回复/转发上下文。

强化方向（计划中）：

- `contextVisibility: "all"`（默认）保持当前的按原样接收行为。
- `contextVisibility: "allowlist"` 将补充上下文过滤到允许列表中的发送者。
- `contextVisibility: "allowlist_quote"` 是 `allowlist` 加上一个明确的引用/回复例外。

在这个强化模型在所有通道上一致实现之前，不同平台会有差异。

![群组消息流程](/images/groups-flow.svg)

如果你想要...

| 目标                                         | 要设置什么                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| 允许所有群组但仅在 @mentions 时回复         | `groups: { "*": { requireMention: true } }`                |
| 禁用所有群组回复                            | `groupPolicy: "disabled"`                                  |
| 仅特定群组                                  | `groups: { "<group-id>": { ... } }` (无 `"*"` 键)         |
| 只有你可以在群组中触发                      | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 会话键

- 群组会话使用 `agent:<agentId>:<channel>:group:<id>` 会话键（房间/频道使用 `agent:<agentId>:<channel>:channel:<id>`）。
- Telegram 论坛主题在群组 ID 后添加 `:topic:<threadId>`，以便每个主题都有自己的会话。
- 直接聊天使用主会话（或按发送者配置）。
- 群组会话跳过心跳。

<a id="pattern-personal-dms-public-groups-single-agent"></a>

## 模式：个人 DM + 公共群组（单个代理）

是的 — 如果你的“个人”流量是**DM**，而“公共”流量是**群组**，这会很好用。

原因：在单代理模式下，DM 通常会进入**主**会话键（`agent:main:main`），而群组始终使用**非主**会话键（`agent:main:<channel>:group:<id>`）。如果你启用了 `mode: "non-main"` 的沙箱，那些群组会话会在 Docker 中运行，而你的主 DM 会话会留在主机上。

这给你一个代理“大脑”（共享工作区 + 内存），但两种执行状态：

- **DM**：完整工具（主机）
- **群组**：沙箱 + 受限工具（Docker）

> 如果你需要真正独立的工作区/角色（“个人”和“公共”绝不能混合），请使用第二个代理 + 绑定。请参阅 [多代理路由](/concepts/multi-agent)。

示例（DM 在主机上，群组沙箱化 + 仅消息工具）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // 群组/频道是非主的 -> 沙箱化
        scope: "session", // 最强隔离（每个群组/频道一个容器）
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // 如果 allow 非空，其他所有内容都被阻止（deny 仍然优先）。
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

想要“群组只能看到文件夹 X”而不是“无主机访问”？保持 `workspaceAccess: "none"` 并仅将允许的路径挂载到沙箱中：

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
            "/home/user/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

相关：

- 配置键和默认值：[网关配置](/gateway/configuration-reference#agentsdefaultssandbox)
- 调试为什么工具被阻止：[沙箱 vs 工具策略 vs 提升](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 绑定挂载详情：[沙箱化](/gateway/sandboxing#custom-bind-mounts)

## 显示标签

- UI 标签在可用时使用 `displayName`，格式为 `<channel>:<token>`。
- `#room` 保留给房间/频道；群组聊天使用 `g-<slug>`（小写，空格 -> `-`，保留 `#@+._-`）。

## 群组策略

控制每个通道如何处理群组/房间消息：

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // 数字 Telegram 用户 ID（向导可以解析 @username）
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
        "!roomId:example.org": { enabled: true },
        "#alias:example.org": { enabled: true },
      },
    },
  },
}
```

| 策略        | 行为                                                     |
| ------------- | ------------------------------------------------------------ |
| `"open"`      | 群组绕过允许列表；提及门控仍然适用。      |
| `"disabled"`  | 完全阻止所有群组消息。                           |
| `"allowlist"` | 仅允许与配置的允许列表匹配的群组/房间。 |

注意：

- `groupPolicy` 与提及门控（需要 @mentions）是分开的。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo：使用 `groupAllowFrom`（回退：明确的 `allowFrom`）。
- DM 配对批准（`*-allowFrom` 存储条目）仅适用于 DM 访问；群组发送者授权保持明确的群组允许列表。
- Discord：允许列表使用 `channels.discord.guilds.<id>.channels`。
- Slack：允许列表使用 `channels.slack.channels`。
- Matrix：允许列表使用 `channels.matrix.groups`。首选房间 ID 或别名；已加入房间名称查找是尽力而为的，未解析的名称在运行时被忽略。使用 `channels.matrix.groupAllowFrom` 限制发送者；也支持每个房间的 `users` 允许列表。
- 群组 DM 单独控制（`channels.discord.dm.*`、`channels.slack.dm.*`）。
- Telegram 允许列表可以匹配用户 ID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`）或用户名（`"@alice"` 或 `"alice"`）；前缀不区分大小写。
- 默认值为 `groupPolicy: "allowlist"`；如果你的群组允许列表为空，群组消息会被阻止。
- 运行时安全：当提供者块完全缺失（`channels.<provider>` 不存在）时，群组策略回退到故障关闭模式（通常为 `allowlist`），而不是继承 `channels.defaults.groupPolicy`。

快速思维模型（群组消息的评估顺序）：

1. `groupPolicy`（open/disabled/allowlist）
2. 群组允许列表（`*.groups`、`*.groupAllowFrom`、通道特定的允许列表）
3. 提及门控（`requireMention`、`/activation`）

## 提及门控（默认）

群组消息需要提及，除非按群组覆盖。默认值位于每个子系统下的 `*.groups."*"`。

当通道支持回复元数据时，回复机器人消息算作隐式提及。在暴露引用元数据的通道上，引用机器人消息也可以算作隐式提及。当前内置案例包括 Telegram、WhatsApp、Slack、Discord、Microsoft Teams 和 ZaloUser。

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

注意：

- `mentionPatterns` 是不区分大小写的安全正则表达式模式；无效模式和不安全的嵌套重复形式被忽略。
- 提供显式提及的平台仍然通过；模式是回退。
- 每代理覆盖：`agents.list[].groupChat.mentionPatterns`（当多个代理共享一个群组时有用）。
- 仅当可以进行提及检测时（配置了原生提及或 `mentionPatterns`），才会强制执行提及门控。
- Discord 默认值位于 `channels.discord.guilds."*"`（可按公会/频道覆盖）。
- 群组历史上下文在所有通道上统一包装，并且是**仅待处理**的（由于提及门控而跳过的消息）；使用 `messages.groupChat.historyLimit` 作为全局默认值，使用 `channels.<channel>.historyLimit`（或 `channels.<channel>.accounts.*.historyLimit`）作为覆盖。设置 `0` 以禁用。

## 群组/频道工具限制（可选）

一些通道配置支持限制**特定群组/房间/频道内**可用的工具。

- `tools`：允许/拒绝整个群组的工具。
- `toolsBySender`：群组内按发送者的覆盖。
  使用显式键前缀：
  `id:<senderId>`、`e164:<phone>`、`username:<handle>`、`name:<displayName>` 和 `"*"` 通配符。
  仍然接受旧的无前缀键，且仅作为 `id:` 匹配。

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
            "id:123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

注意：

- 群组/频道工具限制是在全局/代理工具策略之外应用的（deny 仍然优先）。
- 一些通道对房间/频道使用不同的嵌套（例如，Discord `guilds.*.channels.*`、Slack `channels.*`、Microsoft Teams `teams.*.channels.*`）。

## 群组允许列表

当配置了 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 时，键充当群组允许列表。使用 `"*"` 允许所有群组，同时仍设置默认提及行为。

常见混淆：DM 配对批准与群组授权不同。
对于支持 DM 配对的通道，配对存储仅解锁 DM。群组命令仍然需要来自配置允许列表的明确群组发送者授权，例如 `groupAllowFrom` 或该通道的文档化配置回退。

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

3. 允许所有群组但需要提及（明确）

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 只有所有者可以在群组中触发（WhatsApp）

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

群组所有者可以切换每个群组的激活：

- `/activation mention`
- `/activation always`

所有者由 `channels.whatsapp.allowFrom` 确定（或当未设置时由机器人的自身 E.164 确定）。将命令作为独立消息发送。其他平台当前忽略 `/activation`。

## 上下文字段

群组入站有效负载设置：

- `ChatType=group`
- `GroupSubject`（如果已知）
- `GroupMembers`（如果已知）
- `WasMentioned`（提及门控结果）
- Telegram 论坛主题还包括 `MessageThreadId` 和 `IsForum`。

通道特定说明：

- BlueBubbles 可以选择在填充 `GroupMembers` 之前从本地联系人数据库丰富未命名的 macOS 群组成员。这默认关闭，仅在正常群组门控通过后运行。

代理系统提示在新群组会话的第一轮中包含群组介绍。它提醒模型像人类一样响应，避免 Markdown 表格，最小化空行并遵循正常的聊天间距，避免输入字面 `\n` 序列。

## iMessage 特定

- 路由或允许列表时首选 `chat_id:<id>`。
- 列出聊天：`imsg chats --limit 20`。
- 群组回复总是返回相同的 `chat_id`。

## WhatsApp 特定

请参阅 [群组消息](/channels/group-messages) 了解 WhatsApp 特有的行为（历史注入、提及处理详情）。