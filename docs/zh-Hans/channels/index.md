---
read_when:
  - 你想为 OpenClaw 选择一个聊天渠道
  - 你需要快速了解支持的消息平台
summary: OpenClaw 可连接的消息平台
title: 聊天渠道
x-i18n:
  generated_at: "2026-02-03T07:43:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2632863def6dee97e0fa8b931762f0969174fd4fb22303a00dcd46527fe4a141
  source_path: channels/index.md
  workflow: 15
---

# 聊天渠道

OpenClaw 可以在你已经使用的任何聊天应用上与你交流。每个渠道通过 Gateway 网关连接。
所有渠道都支持文本；媒体和表情回应的支持因渠道而异。

## 支持的渠道

- [BlueBubbles](/channels/bluebubbles) — **推荐用于 iMessage**；使用 BlueBubbles macOS 服务器 REST API，功能完整（编辑、撤回、特效、回应、群组管理——编辑功能在 macOS 26 Tahoe 上目前不可用）。
- [Discord](/channels/discord) — Discord Bot API + Gateway；支持服务器、频道和私信。
- [飞书](/channels/feishu) — 飞书（Lark）机器人（插件，需单独安装）。
- [Google Chat](/channels/googlechat) — 通过 HTTP webhook 的 Google Chat API 应用。
- [iMessage（旧版）](/channels/imessage) — 通过 imsg CLI 的旧版 macOS 集成（已弃用，新设置请使用 BlueBubbles）。
- [LINE](/channels/line) — LINE Messaging API 机器人（插件，需单独安装）。
- [Matrix](/channels/matrix) — Matrix 协议（插件，需单独安装）。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；频道、群组、私信（插件，需单独安装）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企业支持（插件，需单独安装）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 通过 Nextcloud Talk 的自托管聊天（插件，需单独安装）。
- [Nostr](/channels/nostr) — 通过 NIP-04 的去中心化私信（插件，需单独安装）。
- [Signal](/channels/signal) — signal-cli；注重隐私。
- [Slack](/channels/slack) — Bolt SDK；工作区应用。
- [Telegram](/channels/telegram) — 通过 grammY 使用 Bot API；支持群组。
- [Tlon](/channels/tlon) — 基于 Urbit 的消息应用（插件，需单独安装）。
- [Twitch](/channels/twitch) — 通过 IRC 连接的 Twitch 聊天（插件，需单独安装）。
- [WebChat](/web/webchat) — 基于 WebSocket 的 Gateway 网关 WebChat 界面。
- [WhatsApp](/channels/whatsapp) — 最受欢迎；使用 Baileys，需要二维码配对。
- [Zalo](/channels/zalo) — Zalo Bot API；越南流行的消息应用（插件，需单独安装）。
- [Zalo Personal](/channels/zalouser) — 通过二维码登录的 Zalo 个人账号（插件，需单独安装）。

## 注意事项

- 渠道可以同时运行；配置多个渠道后，OpenClaw 会按聊天进行路由。
- 最快的设置方式通常是 **Telegram**（简单的机器人令牌）。WhatsApp 需要二维码配对，
  并在磁盘上存储更多状态。
- 群组行为因渠道而异；参见[群组](/channels/groups)。
- 为安全起见，私信配对和允许列表会被强制执行；参见[安全](/gateway/security)。
- Telegram 内部机制：[grammY 说明](/channels/grammy)。
- 故障排除：[渠道故障排除](/channels/troubleshooting)。
- 模型提供商单独记录；参见[模型提供商](/providers/models)。
