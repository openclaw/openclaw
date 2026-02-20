---
read_when:
  - 开发 Nextcloud Talk 渠道功能时
summary: Nextcloud Talk 支持状态、功能和配置
title: Nextcloud Talk
x-i18n:
  generated_at: "2026-02-03T10:04:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 21b7b9756c4356a76dc0f14c10e44ed74a284cf3badf87e2df75eb88d8a90c31
  source_path: channels/nextcloud-talk.md
  workflow: 15
---

# Nextcloud Talk（插件）

状态：通过插件支持（webhook 机器人）。支持私信、房间、表情回应和 Markdown 消息。

## 需要插件

Nextcloud Talk 以插件形式提供，不包含在核心安装包中。

通过 CLI 安装（npm 仓库）：

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

本地检出安装（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

如果你在配置/新手引导过程中选择了 Nextcloud Talk，并且检测到 git 检出，
OpenClaw 将自动提供本地安装路径。

详情：[插件](/tools/plugin)

## 快速设置（新手）

1. 安装 Nextcloud Talk 插件。
2. 在你的 Nextcloud 服务器上创建机器人：
   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```
3. 在目标房间设置中启用机器人。
4. 配置 OpenClaw：
   - 配置项：`channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 或环境变量：`NEXTCLOUD_TALK_BOT_SECRET`（仅默认账户）
5. 重启 Gateway 网关（或完成新手引导）。

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

- 机器人无法主动发起私信。用户必须先向机器人发送消息。
- Webhook URL 必须可被 Gateway 网关访问；如果在代理后面，请设置 `webhookPublicUrl`。
- 机器人 API 不支持媒体上传；媒体以 URL 形式发送。
- Webhook 载荷无法区分私信和房间；设置 `apiUser` + `apiPassword` 以启用房间类型查询（否则私信将被视为房间）。

## 访问控制（私信）

- 默认：`channels.nextcloud-talk.dmPolicy = "pairing"`。未知发送者将收到配对码。
- 批准方式：
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公开私信：`channels.nextcloud-talk.dmPolicy="open"` 加上 `channels.nextcloud-talk.allowFrom=["*"]`。

## 房间（群组）

- 默认：`channels.nextcloud-talk.groupPolicy = "allowlist"`（需要提及触发）。
- 使用 `channels.nextcloud-talk.rooms` 设置房间白名单：

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

- 如需禁止所有房间，保持白名单为空或设置 `channels.nextcloud-talk.groupPolicy="disabled"`。

## 功能支持

| 功能     | 状态   |
| -------- | ------ |
| 私信     | 支持   |
| 房间     | 支持   |
| 话题     | 不支持 |
| 媒体     | 仅 URL |
| 表情回应 | 支持   |
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
- `channels.nextcloud-talk.allowFrom`：私信白名单（用户 ID）。`open` 需要 `"*"`。
- `channels.nextcloud-talk.groupPolicy`：`allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`：群组白名单（用户 ID）。
- `channels.nextcloud-talk.rooms`：每个房间的设置和白名单。
- `channels.nextcloud-talk.historyLimit`：群组历史记录限制（0 表示禁用）。
- `channels.nextcloud-talk.dmHistoryLimit`：私信历史记录限制（0 表示禁用）。
- `channels.nextcloud-talk.dms`：每个私信的覆盖设置（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`：出站文本分块大小（字符数）。
- `channels.nextcloud-talk.chunkMode`：`length`（默认）或 `newline`，在长度分块前按空行（段落边界）分割。
- `channels.nextcloud-talk.blockStreaming`：禁用此渠道的分块流式传输。
- `channels.nextcloud-talk.blockStreamingCoalesce`：分块流式传输合并调优。
- `channels.nextcloud-talk.mediaMaxMb`：入站媒体大小上限（MB）。
