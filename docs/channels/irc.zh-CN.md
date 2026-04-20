---
title: IRC
summary: "IRC 插件设置、访问控制和故障排除"
read_when:
  - 您想将 OpenClaw 连接到 IRC 频道或 DM
  - 您正在配置 IRC 允许列表、群组策略或提及门控
---

# IRC

当您希望 OpenClaw 在经典频道（`#room`）和直接消息中时使用 IRC。
IRC 作为扩展插件提供，但在主配置的 `channels.irc` 下配置。

## 快速开始

1. 在 `~/.openclaw/openclaw.json` 中启用 IRC 配置。
2. 至少设置：

```json5
{
  channels: {
    irc: {
      enabled: true,
      host: "irc.example.com",
      port: 6697,
      tls: true,
      nick: "openclaw-bot",
      channels: ["#openclaw"],
    },
  },
}
```

对于机器人协调，首选私有 IRC 服务器。如果您有意使用公共 IRC 网络，常见选择包括 Libera.Chat、OFTC 和 Snoonet。避免为机器人或集群后台通信使用可预测的公共频道。

3. 启动/重启网关：

```bash
openclaw gateway run
```

## 安全默认值

- `channels.irc.dmPolicy` 默认值为 `"pairing"`。
- `channels.irc.groupPolicy` 默认值为 `"allowlist"`。
- 使用 `groupPolicy="allowlist"` 时，设置 `channels.irc.groups` 以定义允许的频道。
- 除非您有意接受明文传输，否则使用 TLS（`channels.irc.tls=true`）。

## 访问控制

IRC 频道有两个独立的“门”：

1. **频道访问**（`groupPolicy` + `groups`）：机器人是否接受来自频道的消息。
2. **发送者访问**（`groupAllowFrom` / 每频道 `groups["#channel"].allowFrom`）：谁被允许在该频道内触发机器人。

配置键：

- DM 允许列表（DM 发送者访问）：`channels.irc.allowFrom`
- 群组发送者允许列表（频道发送者访问）：`channels.irc.groupAllowFrom`
- 每频道控制（频道 + 发送者 + 提及规则）：`channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` 允许未配置的频道（**默认仍需提及门控**）

允许列表条目应使用稳定的发送者身份（`nick!user@host`）。
只有当 `channels.irc.dangerouslyAllowNameMatching: true` 时，才启用可变的裸昵称匹配。

### 常见陷阱：`allowFrom` 用于 DM，而非频道

如果您看到类似以下的日志：

- `irc: drop group sender alice!ident@host (policy=allowlist)`

…这意味着发送者不被允许发送**群组/频道**消息。通过以下方式修复：

- 设置 `channels.irc.groupAllowFrom`（全局适用于所有频道），或
- 设置每频道发送者允许列表：`channels.irc.groups["#channel"].allowFrom`

示例（允许 `#tuirc-dev` 中的任何人与机器人交谈）：

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": { allowFrom: ["*"] },
      },
    },
  },
}
```

## 回复触发（提及）

即使频道被允许（通过 `groupPolicy` + `groups`）且发送者被允许，OpenClaw 在群组上下文中默认为**提及门控**。

这意味着您可能会看到类似 `drop channel … (missing-mention)` 的日志，除非消息包含与机器人匹配的提及模式。

要使机器人在 IRC 频道中回复**无需提及**，为该频道禁用提及门控：

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": {
          requireMention: false,
          allowFrom: ["*"],
        },
      },
    },
  },
}
```

或者允许**所有** IRC 频道（无每频道允许列表）并在无需提及时回复：

```json5
{
  channels: {
    irc: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false, allowFrom: ["*"] },
      },
    },
  },
}
```

## 安全注意（公共频道推荐）

如果您在公共频道中允许 `allowFrom: ["*"]`，任何人都可以提示机器人。
为降低风险，请限制该频道的工具。

### 频道中所有人使用相同的工具

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          tools: {
            deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
          },
        },
      },
    },
  },
}
```

### 每个发送者不同的工具（所有者获得更多权限）

使用 `toolsBySender` 对 `"*"` 应用更严格的策略，对您的昵称应用更宽松的策略：

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          toolsBySender: {
            "*": {
              deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
            },
            "id:eigen": {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

注意：

- `toolsBySender` 键应使用 `id:` 作为 IRC 发送者身份值：
  `id:eigen` 或 `id:eigen!~eigen@174.127.248.171` 用于更强的匹配。
- 仍然接受传统的无前缀键，且仅作为 `id:` 匹配。
- 第一个匹配的发送者策略获胜；`"*"` 是通配符回退。

有关群组访问与提及门控（以及它们如何交互）的更多信息，请参见：[/channels/groups](/channels/groups)。

## NickServ

要在连接后向 NickServ 识别：

```json5
{
  channels: {
    irc: {
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "your-nickserv-password",
      },
    },
  },
}
```

连接时的可选一次性注册：

```json5
{
  channels: {
    irc: {
      nickserv: {
        register: true,
        registerEmail: "bot@example.com",
      },
    },
  },
}
```

在昵称注册后禁用 `register`，以避免重复的 REGISTER 尝试。

## 环境变量

默认账户支持：

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS`（逗号分隔）
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

## 故障排除

- 如果机器人连接但从未在频道中回复，验证 `channels.irc.groups` **以及**提及门控是否丢弃消息（`missing-mention`）。如果您希望它在无需 ping 的情况下回复，为频道设置 `requireMention:false`。
- 如果登录失败，验证昵称可用性和服务器密码。
- 如果自定义网络上的 TLS 失败，验证主机/端口和证书设置。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化