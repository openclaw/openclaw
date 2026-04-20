---
summary: "OpenClaw 可以连接的消息平台"
read_when:
  - 你想为 OpenClaw 选择聊天通道
  - 你需要快速了解支持的消息平台
  - 你想比较不同通道的功能和设置难度
title: "聊天通道"
---

# 聊天通道

OpenClaw 可以在你已经使用的任何聊天应用上与你交流。每个通道通过网关连接。
所有通道都支持文本；媒体和反应功能因通道而异。

## 支持的通道

- [BlueBubbles](/channels/bluebubbles) — **iMessage 推荐选择**；使用 BlueBubbles macOS 服务器 REST API，支持完整功能（内置插件；编辑、撤回、效果、反应、群组管理 — 目前在 macOS 26 Tahoe 上编辑功能损坏）。
- [Discord](/channels/discord) — Discord 机器人 API + 网关；支持服务器、频道和私信。
- [飞书](/channels/feishu) — 飞书/ Lark 机器人通过 WebSocket（内置插件）。
- [Google Chat](/channels/googlechat) — Google Chat API 应用通过 HTTP webhook。
- [iMessage（传统）](/channels/imessage) — 传统 macOS 集成通过 imsg CLI（已弃用，新设置请使用 BlueBubbles）。
- [IRC](/channels/irc) — 经典 IRC 服务器；频道 + 私信，带有配对/允许列表控制。
- [LINE](/channels/line) — LINE 消息 API 机器人（内置插件）。
- [Matrix](/channels/matrix) — Matrix 协议（内置插件）。
- [Mattermost](/channels/mattermost) — 机器人 API + WebSocket；频道、群组、私信（内置插件）。
- [Microsoft Teams](/channels/msteams) — 机器人框架；企业支持（内置插件）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 通过 Nextcloud Talk 进行自托管聊天（内置插件）。
- [Nostr](/channels/nostr) — 通过 NIP-04 的去中心化私信（内置插件）。
- [QQ 机器人](/channels/qqbot) — QQ 机器人 API；私聊、群聊和富媒体（内置插件）。
- [Signal](/channels/signal) — signal-cli；注重隐私。
- [Slack](/channels/slack) — Bolt SDK；工作区应用。
- [Synology Chat](/channels/synology-chat) — Synology NAS 聊天通过出站+入站 webhook（内置插件）。
- [Telegram](/channels/telegram) — 通过 grammY 的机器人 API；支持群组。
- [Tlon](/channels/tlon) — 基于 Urbit 的 messenger（内置插件）。
- [Twitch](/channels/twitch) — 通过 IRC 连接的 Twitch 聊天（内置插件）。
- [语音通话](/plugins/voice-call) — 通过 Plivo 或 Twilio 的电话服务（插件，需单独安装）。
- [WebChat](/web/webchat) — 通过 WebSocket 的网关 WebChat UI。
- [微信](/channels/wechat) — 腾讯 iLink 机器人插件通过二维码登录；仅支持私聊（外部插件）。
- [WhatsApp](/channels/whatsapp) — 最受欢迎；使用 Baileys，需要二维码配对。
- [Zalo](/channels/zalo) — Zalo 机器人 API；越南流行的 messenger（内置插件）。
- [Zalo 个人](/channels/zalouser) — 通过二维码登录的 Zalo 个人账户（内置插件）。

## 注意事项

- 通道可以同时运行；配置多个通道，OpenClaw 会按聊天进行路由。
- 最快的设置通常是**Telegram**（简单的机器人令牌）。WhatsApp 需要二维码配对，并且在磁盘上存储更多状态。
- 群组行为因通道而异；请参阅[群组](/channels/groups)。
- 为安全起见，强制执行私信配对和允许列表；请参阅[安全](/gateway/security)。
- 故障排除：[通道故障排除](/channels/troubleshooting)。
- 模型提供者单独记录；请参阅[模型提供者](/providers/models)。
