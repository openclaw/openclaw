---
title: IRC
summary: "IRC 插件设置、访问控制和故障排除"
read_when:
  - 你想将 OpenClaw 连接到 IRC 频道或私信
  - 你正在配置 IRC 允许列表、组策略或提及门控
---

# IRC

当你想让 OpenClaw 出现在经典频道（`#room`）和私信中时，请使用 IRC。
IRC 作为扩展插件提供，但它在主配置的 `channels.irc` 下配置。

## 快速开始

1. 在 `~/.openclaw/openclaw.json` 中启用 IRC 配置。
2. 至少设置：

```json5
{
  channels: {
    irc: {
      enabled: true,
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      nick: "openclaw-bot",
      channels: ["#openclaw"],
    },
  },
}
```

3. 启动/重启 gateway：

```bash
openclaw gateway run
```

## 安全默认值

- `channels.irc.dmPolicy` 默认为 `"pairing"`。
- `channels.irc.groupPolicy` 默认为 `"allowlist"`。
- 使用 `groupPolicy="allowlist"` 时，设置 `channels.irc.groups` 定义允许的频道。
- 使用 TLS（`channels.irc.tls=true`），除非你有意接受明文传输。

## 访问控制

IRC 频道有两个独立的"门"：

1. **频道访问**（`groupPolicy` + `groups`）：机器人是否完全接受来自频道的消息。
2. **发送者访问**（`groupAllowFrom` / 每频道 `groups["#channel"].allowFrom`）：谁被允许在该频道内触发机器人。

配置键：

- DM 允许列表（DM 发送者访问）：`channels.irc.allowFrom`
- 组发送者允许列表（频道发送者访问）：`channels.irc.groupAllowFrom`
- 每频道控制（频道 + 发送者 + 提及规则）：`channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` 允许未配置的频道（**默认仍然受提及门控**）

允许列表条目应使用稳定的发送者身份（`nick!user@host`）。
裸昵称匹配是可变的，仅在 `channels.irc.dangerouslyAllowNameMatching: true` 时启用。

### 常见陷阱：`allowFrom` 用于 DM，不是频道

如果你看到类似日志：

- `irc: drop group sender alice!ident@host (policy=allowlist)`

…这意味着发送者不被允许发送**组/频道**消息。通过以下方式修复：

- 设置 `channels.irc.groupAllowFrom`（所有频道的全局设置），或
- 设置每频道发送者允许列表：`channels.irc.groups["#channel"].allowFrom`

示例（允许 `#tuirc-dev` 中的任何人向机器人发送消息）：

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

即使频道被允许（通过 `groupPolicy` + `groups`）且发送者被允许，OpenClaw 在组上下文中默认使用**提及门控**。

这意味着你可能会看到类似 `drop channel … (missing-mention)` 的日志，除非消息包含匹配机器人的提及模式。

要让机器人在 IRC 频道中**无需提及即可回复**，为该频道禁用提及门控：

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

或者允许**所有** IRC 频道（无每频道允许列表）且仍然无需提及即可回复：

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

## 安全说明（推荐用于公共频道）

如果你在公共频道中允许 `allowFrom: ["*"]`，任何人都可以提示机器人。
为了降低风险，为该频道限制工具。

### 频道中所有人使用相同工具

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

### 每个发送者使用不同工具（所有者获得更多权限）

使用 `toolsBySender` 对 `"*"` 应用更严格的策略，对你的昵称应用更宽松的策略：

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

- `toolsBySender` 键应对 IRC 发送者身份值使用 `id:` 前缀：
  `id:eigen` 或 `id:eigen!~eigen@174.127.248.171` 用于更强的匹配。
- 旧版无前缀键仍然被接受并仅作为 `id:` 匹配。
- 第一个匹配的发送者策略获胜；`"*"` 是通配符回退。

有关组访问与提及门控（以及它们如何交互）的更多信息，请参阅：[/channels/groups](/channels/groups)。

## NickServ

要在连接后向 NickServ 认证：

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

可选的连接时一次性注册：

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

昵称注册后禁用 `register` 以避免重复 REGISTER 尝试。

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

- 如果机器人连接但从未在频道中回复，请验证 `channels.irc.groups` **以及** 提及门控是否正在丢弃消息（`missing-mention`）。如果你希望它在没有 ping 的情况下回复，为该频道设置 `requireMention:false`。
- 如果登录失败，请验证昵称可用性和服务器密码。
- 如果 TLS 在自定义网络上失败，请验证主机/端口和证书设置。