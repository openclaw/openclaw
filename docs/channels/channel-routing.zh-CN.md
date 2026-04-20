---
summary: "每个通道（WhatsApp、Telegram、Discord、Slack）的路由规则和共享上下文"
read_when:
  - 更改通道路由或收件箱行为
title: "通道路由"
---

# 通道与路由

OpenClaw 将回复**路由回消息来源的通道**。模型不会选择通道；路由是确定性的，由主机配置控制。

## 关键术语

- **通道**：`telegram`、`whatsapp`、`discord`、`irc`、`googlechat`、`slack`、`signal`、`imessage`、`line`，以及扩展通道。`webchat` 是内部 WebChat UI 通道，不是可配置的出站通道。
- **AccountId**：每个通道的账户实例（当支持时）。
- 可选的通道默认账户：`channels.<channel>.defaultAccount` 选择当出站路径未指定 `accountId` 时使用哪个账户。
  - 在多账户设置中，当配置了两个或更多账户时，设置明确的默认值（`defaultAccount` 或 `accounts.default`）。否则，回退路由可能会选择第一个标准化的账户 ID。
- **AgentId**：隔离的工作区 + 会话存储（"大脑"）。
- **SessionKey**：用于存储上下文和控制并发的存储桶键。

## 会话键形状（示例）

直接消息折叠到代理的**主**会话：

- `agent:<agentId>:<mainKey>`（默认：`agent:main:main`）

群组和频道保持按通道隔离：

- 群组：`agent:<agentId>:<channel>:group:<id>`
- 频道/房间：`agent:<agentId>:<channel>:channel:<id>`

线程：

- Slack/Discord 线程在基础键后附加 `:thread:<threadId>`。
- Telegram 论坛主题在群组键中嵌入 `:topic:<topicId>`。

示例：

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 主 DM 路由固定

当 `session.dmScope` 为 `main` 时，直接消息可能共享一个主会话。为防止会话的 `lastRoute` 被非所有者的 DM 覆盖，当所有以下条件都为真时，OpenClaw 会从 `allowFrom` 推断一个固定的所有者：

- `allowFrom` 恰好有一个非通配符条目。
- 该条目可以标准化为该通道的具体发送者 ID。
- 入站 DM 发送者与该固定所有者不匹配。

在这种不匹配的情况下，OpenClaw 仍会记录入站会话元数据，但会跳过更新主会话的 `lastRoute`。

## 路由规则（如何选择代理）

路由为每个入站消息选择**一个代理**：

1. **精确对等匹配**（带有 `peer.kind` + `peer.id` 的 `bindings`）。
2. **父对等匹配**（线程继承）。
3. **公会 + 角色匹配**（Discord）通过 `guildId` + `roles`。
4. **公会匹配**（Discord）通过 `guildId`。
5. **团队匹配**（Slack）通过 `teamId`。
6. **账户匹配**（通道上的 `accountId`）。
7. **通道匹配**（该通道上的任何账户，`accountId: "*"`）。
8. **默认代理**（`agents.list[].default`，否则为列表的第一个条目，回退到 `main`）。

当绑定包含多个匹配字段（`peer`、`guildId`、`teamId`、`roles`）时，**所有提供的字段都必须匹配**才能应用该绑定。

匹配的代理决定使用哪个工作区和会话存储。

## 广播群组（运行多个代理）

广播群组允许你为同一个对等方运行**多个代理**，**当 OpenClaw 通常会回复时**（例如：在 WhatsApp 群组中，在提及/激活门控之后）。

配置：

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

请参阅：[广播群组](/channels/broadcast-groups)。

## 配置概述

- `agents.list`：命名代理定义（工作区、模型等）。
- `bindings`：将入站通道/账户/对等方映射到代理。

示例：

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## 会话存储

会话存储位于状态目录下（默认 `~/.openclaw`）：

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 转录本与存储一起存在

你可以通过 `session.store` 和 `{agentId}` 模板覆盖存储路径。

网关和 ACP 会话发现还会扫描默认 `agents/` 根目录下以及模板化 `session.store` 根目录下的磁盘备份代理存储。发现的存储必须位于解析后的代理根目录内，并使用常规的 `sessions.json` 文件。符号链接和根外路径将被忽略。

## WebChat 行为

WebChat 附加到**选定的代理**，并默认为代理的主会话。因此，WebChat 允许你在一个地方查看该代理的跨通道上下文。

## 回复上下文

入站回复包括：

- 当可用时的 `ReplyToId`、`ReplyToBody` 和 `ReplyToSender`。
- 引用的上下文作为 `[Replying to ...]` 块附加到 `Body`。

这在所有通道中都是一致的。
