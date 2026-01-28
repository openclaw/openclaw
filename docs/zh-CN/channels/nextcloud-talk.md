---
read_when:
  - 开发 Nextcloud Talk 渠道功能
summary: Nextcloud Talk 支持状态、功能和配置
title: Nextcloud Talk
x-i18n:
  generated_at: "2026-02-01T19:26:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 21b7b9756c4356a76dc0f14c10e44ed74a284cf3badf87e2df75eb88d8a90c31
  source_path: channels/nextcloud-talk.md
  workflow: 14
---

# Nextcloud Talk（插件）

状态：通过插件支持（webhook 机器人）。支持私信、房间、回应和 markdown 消息。

## 需要插件

Nextcloud Talk 作为插件发布，不包含在核心安装中。

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

如果你在配置/新手引导期间选择了 Nextcloud Talk 并检测到 git 检出，OpenClaw 会自动提供本地安装路径。

详情：[插件](/plugin)

## 快速设置（新手）

1. 安装 Nextcloud Talk 插件。
2. 在你的 Nextcloud 服务器上创建一个机器人：
   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```
3. 在目标房间设置中启用该机器人。
4. 配置 OpenClaw：
   - 配置：`channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 或环境变量：`NEXTCLOUD_TALK_BOT_SECRET`（仅默认账户）
5. 重启 Gateway网关（或完成新手引导）。

最小配置：

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## 注意事项

- 机器人无法主动发起私信。用户必须先给机器人发消息。
- Webhook URL 必须能被 Gateway网关访问；如果在代理后面，请设置 `webhookPublicUrl`。
- 机器人 API 不支持媒体上传；媒体以 URL 形式发送。
- Webhook 负载不区分私信和房间；设置 `apiUser` + `apiPassword` 以启用房间类型查询（否则私信会被视为房间）。

## 访问控制（私信）

- 默认：`channels.nextcloud-talk.dmPolicy = "pairing"`。未知发送者会收到配对码。
- 通过以下方式批准：
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公开私信：`channels.nextcloud-talk.dmPolicy="open"` 加上 `channels.nextcloud-talk.allowFrom=["*"]`。

## 房间（群组）

- 默认：`channels.nextcloud-talk.groupPolicy = "allowlist"`（提及门控）。
- 使用 `channels.nextcloud-talk.rooms` 允许列表中的房间：

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- 要不允许任何房间，保持允许列表为空或设置 `channels.nextcloud-talk.groupPolicy="disabled"`。

## 功能

| 功能     | 状态   |
| -------- | ------ |
| 私信     | 支持   |
| 房间     | 支持   |
| 线程     | 不支持 |
| 媒体     | 仅 URL |
| 回应     | 支持   |
| 原生命令 | 不支持 |

## 配置参考（Nextcloud Talk）

完整配置：[配置](/gateway/configuration)

提供商选项：

- `channels.nextcloud-talk.enabled`：启用/禁用渠道启动。
- `channels.nextcloud-talk.baseUrl`：Nextcloud 实例 URL。
- `channels.nextcloud-talk.botSecret`：机器人共享密钥。
- `channels.nextcloud-talk.botSecretFile`：密钥文件路径。
- `channels.nextcloud-talk.apiUser`：用于房间查询的 API 用户（私信检测）。
- `channels.nextcloud-talk.apiPassword`：用于房间查询的 API/应用密码。
- `channels.nextcloud-talk.apiPasswordFile`：API 密码文件路径。
- `channels.nextcloud-talk.webhookPort`：webhook 监听端口（默认：8788）。
- `channels.nextcloud-talk.webhookHost`：webhook 主机（默认：0.0.0.0）。
- `channels.nextcloud-talk.webhookPath`：webhook 路径（默认：/nextcloud-talk-webhook）。
- `channels.nextcloud-talk.webhookPublicUrl`：外部可达的 webhook URL。
- `channels.nextcloud-talk.dmPolicy`：`pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`：私信允许列表（用户 ID）。`open` 需要 `"*"`。
- `channels.nextcloud-talk.groupPolicy`：`allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`：群组允许列表（用户 ID）。
- `channels.nextcloud-talk.rooms`：按房间设置和允许列表。
- `channels.nextcloud-talk.historyLimit`：群组历史限制（0 禁用）。
- `channels.nextcloud-talk.dmHistoryLimit`：私信历史限制（0 禁用）。
- `channels.nextcloud-talk.dms`：按私信覆盖（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`：出站文本分块大小（字符）。
- `channels.nextcloud-talk.chunkMode`：`length`（默认）或 `newline`，在按长度分块之前按空行（段落边界）分割。
- `channels.nextcloud-talk.blockStreaming`：禁用此渠道的分块流式传输。
- `channels.nextcloud-talk.blockStreamingCoalesce`：分块流式传输合并调优。
- `channels.nextcloud-talk.mediaMaxMb`：入站媒体上限（MB）。
