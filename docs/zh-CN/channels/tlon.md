---
read_when:
  - 开发 Tlon/Urbit 渠道功能
summary: Tlon/Urbit 支持状态、功能和配置
title: Tlon
x-i18n:
  generated_at: "2026-02-03T07:44:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 19d7ffe23e82239fd2a2e35913e0d52c809b2c2b939dd39184e6c27a539ed97d
  source_path: channels/tlon.md
  workflow: 15
---

# Tlon（插件）

Tlon 是一个基于 Urbit 构建的去中心化即时通讯工具。OpenClaw 连接到你的 Urbit ship，可以响应私信和群聊消息。群组回复默认需要 @ 提及，并可通过允许列表进一步限制。

状态：通过插件支持。支持私信、群组提及、话题回复和纯文本媒体回退（URL 附加到说明文字）。不支持表情回应、投票和原生媒体上传。

## 需要插件

Tlon 作为插件提供，不包含在核心安装中。

通过 CLI 安装（npm 仓库）：

```bash
openclaw plugins install @openclaw/tlon
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/tlon
```

详情：[插件](/plugin)

## 设置

1. 安装 Tlon 插件。
2. 获取你的 ship URL 和登录代码。
3. 配置 `channels.tlon`。
4. 重启 Gateway 网关。
5. 私信机器人或在群组频道中提及它。

最小配置（单账户）：

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## 群组频道

默认启用自动发现。你也可以手动固定频道：

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

禁用自动发现：

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## 访问控制

私信允许列表（空 = 允许全部）：

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

群组授权（默认受限）：

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## 投递目标（CLI/cron）

与 `openclaw message send` 或 cron 投递一起使用：

- 私信：`~sampel-palnet` 或 `dm/~sampel-palnet`
- 群组：`chat/~host-ship/channel` 或 `group:~host-ship/channel`

## 注意事项

- 群组回复需要提及（例如 `~your-bot-ship`）才能响应。
- 话题回复：如果入站消息在话题中，OpenClaw 会在话题内回复。
- 媒体：`sendMedia` 回退为文本 + URL（无原生上传）。
