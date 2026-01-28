---
read_when:
  - 你想为 OpenClaw 选择一个聊天渠道
  - 你需要快速了解支持的消息平台
summary: OpenClaw 可连接的消息平台
title: 聊天渠道
x-i18n:
  generated_at: "2026-02-01T19:21:22Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2632863def6dee97e0fa8b931762f0969174fd4fb22303a00dcd46527fe4a141
  source_path: channels/index.md
  workflow: 14
---

# 聊天渠道

OpenClaw 可以在你已经使用的任何聊天应用上与你对话。每个渠道通过 Gateway网关连接。所有渠道都支持文本；媒体和回应功能因渠道而异。

## 支持的渠道

- [WhatsApp](/channels/whatsapp) — 最受欢迎；使用 Baileys 并需要二维码配对。
- [Telegram](/channels/telegram) — 通过 grammY 使用 Bot API；支持群组。
- [Discord](/channels/discord) — Discord Bot API + Gateway网关；支持服务器、频道和私信。
- [Slack](/channels/slack) — Bolt SDK；工作区应用。
- [Google Chat](/channels/googlechat) — 通过 HTTP webhook 使用 Google Chat API 应用。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；频道、群组、私信（插件，需单独安装）。
- [Signal](/channels/signal) — signal-cli；注重隐私。
- [BlueBubbles](/channels/bluebubbles) — **推荐用于 iMessage**；使用 BlueBubbles macOS 服务器 REST API，功能完整（编辑、撤回、特效、回应、群组管理——编辑功能在 macOS 26 Tahoe 上目前不可用）。
- [iMessage](/channels/imessage) — 仅限 macOS；通过 imsg 原生集成（旧版，新设置建议使用 BlueBubbles）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企业支持（插件，需单独安装）。
- [LINE](/channels/line) — LINE Messaging API 机器人（插件，需单独安装）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 通过 Nextcloud Talk 的自托管聊天（插件，需单独安装）。
- [Matrix](/channels/matrix) — Matrix 协议（插件，需单独安装）。
- [Nostr](/channels/nostr) — 通过 NIP-04 的去中心化私信（插件，需单独安装）。
- [Tlon](/channels/tlon) — 基于 Urbit 的通讯工具（插件，需单独安装）。
- [Twitch](/channels/twitch) — 通过 IRC 连接的 Twitch 聊天（插件，需单独安装）。
- [Zalo](/channels/zalo) — Zalo Bot API；越南流行的通讯工具（插件，需单独安装）。
- [Zalo Personal](/channels/zalouser) — 通过二维码登录的 Zalo 个人账户（插件，需单独安装）。
- [WebChat](/web/webchat) — 通过 WebSocket 的 Gateway网关 WebChat UI。

## 注意事项

- 渠道可以同时运行；配置多个渠道后 OpenClaw 会按聊天路由。
- 最快的设置通常是 **Telegram**（简单的 bot token）。WhatsApp 需要二维码配对并在磁盘上存储更多状态。
- 群组行为因渠道而异；参见[群组](/concepts/groups)。
- 私信配对和允许列表出于安全考虑强制执行；参见[安全](/gateway/security)。
- Telegram 内部实现：[grammY 说明](/channels/grammy)。
- 故障排除：[渠道故障排除](/channels/troubleshooting)。
- 模型提供商单独文档化；参见[模型提供商](/providers/models)。
