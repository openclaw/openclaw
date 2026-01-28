---
read_when:
  - 设置 Mattermost
  - 调试 Mattermost 路由
summary: Mattermost 机器人设置和 OpenClaw 配置
title: Mattermost
x-i18n:
  generated_at: "2026-02-01T19:22:40Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 57fabe5eb0efbcb885f4178b317b2fa99a41daf609e3a471de2b44db9def4ad7
  source_path: channels/mattermost.md
  workflow: 14
---

# Mattermost（插件）

状态：通过插件支持（bot token + WebSocket 事件）。支持频道、群组和私信。Mattermost 是一个可自托管的团队消息平台；有关产品详情和下载请访问官方网站 [mattermost.com](https://mattermost.com)。

## 需要插件

Mattermost 作为插件发布，不包含在核心安装中。

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/mattermost
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/mattermost
```

如果你在配置/新手引导期间选择了 Mattermost 并检测到 git 检出，OpenClaw 会自动提供本地安装路径。

详情：[插件](/plugin)

## 快速设置

1. 安装 Mattermost 插件。
2. 创建一个 Mattermost 机器人账户并复制 **bot token**。
3. 复制 Mattermost **基础 URL**（例如 `https://chat.example.com`）。
4. 配置 OpenClaw 并启动 Gateway网关。

最小配置：

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## 环境变量（默认账户）

如果你偏好使用环境变量，请在 Gateway网关主机上设置：

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

环境变量仅适用于**默认**账户（`default`）。其他账户必须使用配置值。

## 聊天模式

Mattermost 自动响应私信。频道行为由 `chatmode` 控制：

- `oncall`（默认）：仅在频道中被 @提及时响应。
- `onmessage`：响应频道中的每条消息。
- `onchar`：当消息以触发前缀开头时响应。

配置示例：

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

注意事项：

- `onchar` 模式仍然响应明确的 @提及。
- `channels.mattermost.requireMention` 对旧版配置仍然有效，但推荐使用 `chatmode`。

## 访问控制（私信）

- 默认：`channels.mattermost.dmPolicy = "pairing"`（未知发送者会收到配对码）。
- 通过以下方式批准：
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公开私信：`channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。

## 频道（群组）

- 默认：`channels.mattermost.groupPolicy = "allowlist"`（提及门控）。
- 使用 `channels.mattermost.groupAllowFrom` 允许列表发送者（用户 ID 或 `@username`）。
- 开放频道：`channels.mattermost.groupPolicy="open"`（提及门控）。

## 出站投递目标

在 `openclaw message send` 或定时任务/webhook 中使用以下目标格式：

- `channel:<id>` 用于频道
- `user:<id>` 用于私信
- `@username` 用于私信（通过 Mattermost API 解析）

裸 ID 被视为频道。

## 多账户

Mattermost 支持在 `channels.mattermost.accounts` 下配置多个账户：

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 故障排除

- 频道中没有回复：确保机器人已加入频道并提及它（oncall 模式），使用触发前缀（onchar 模式），或设置 `chatmode: "onmessage"`。
- 认证错误：检查 bot token、基础 URL 以及账户是否已启用。
- 多账户问题：环境变量仅适用于 `default` 账户。
