---
summary: "OpenClaw 可以连接的消息平台"
read_when:
  - 您想为 OpenClaw 选择一个聊天频道
  - 您需要支持的消息平台的快速概述
title: "聊天频道"
---

# 聊天频道

OpenClaw 可以在您已经使用的任何聊天应用上与您交流。每个频道通过网关连接。
所有地方都支持文本；媒体和反应因频道而异。

## 支持的频道

- [BlueBubbles](/channels/bluebubbles) — **iMessage 推荐**；使用 BlueBubbles macOS 服务器 REST API，支持完整功能（捆绑插件；编辑、撤销发送、效果、反应、群组管理 — 在 macOS 26 Tahoe 上编辑当前已损坏）。
- [Discord](/channels/discord) — Discord Bot API + 网关；支持服务器、频道和 DM。
- [飞书](/channels/feishu) — 通过 WebSocket 的飞书/ Lark 机器人（捆绑插件）。
- [Google Chat](/channels/googlechat) — 通过 HTTP webhook 的 Google Chat API 应用。
- [iMessage（ legacy）](/channels/imessage) — 通过 imsg CLI 的传统 macOS 集成（已弃用，新设置使用 BlueBubbles）。
- [IRC](/channels/irc) — 经典 IRC 服务器；带配对/允许列表控制的频道 + DM。
- [LINE](/channels/line) — LINE 消息 API 机器人（捆绑插件）。
- [Matrix](/channels/matrix) — Matrix 协议（捆绑插件）。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；频道、群组、DM（捆绑插件）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企业支持（捆绑插件）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 通过 Nextcloud Talk 的自托管聊天（捆绑插件）。
- [Nostr](/channels/nostr) — 通过 NIP-04 的去中心化 DM（捆绑插件）。
- [QQ 机器人](/channels/qqbot) — QQ Bot API；私聊、群聊和富媒体（捆绑插件）。
- [Signal](/channels/signal) — signal-cli；注重隐私。
- [Slack](/channels/slack) — Bolt SDK；工作区应用。
- [Synology Chat](/channels/synology-chat) — 通过出站+入站 webhook 的 Synology NAS 聊天（捆绑插件）。
- [Telegram](/channels/telegram) — 通过 grammY 的 Bot API；支持群组。
- [Tlon](/channels/tlon) — 基于 Urbit 的 messenger（捆绑插件）。
- [Twitch](/channels/twitch) — 通过 IRC 连接的 Twitch 聊天（捆绑插件）。
- [语音通话](/plugins/voice-call) — 通过 Plivo 或 Twilio 的电话（插件，单独安装）。
- [WebChat](/web/webchat) — 通过 WebSocket 的网关 WebChat UI。
- [微信](/channels/wechat) — 通过 QR 登录的腾讯 iLink 机器人插件；仅支持私聊（外部插件）。
- [WhatsApp](/channels/whatsapp) — 最流行；使用 Baileys 并需要 QR 配对。
- [Zalo](/channels/zalo) — Zalo Bot API；越南流行的 messenger（捆绑插件）。
- [Zalo Personal](/channels/zalouser) — 通过 QR 登录的 Zalo 个人账户（捆绑插件）。

## 注意事项

- 频道可以同时运行；配置多个，OpenClaw 将按聊天路由。
- 最快的设置通常是**Telegram**（简单的机器人令牌）。WhatsApp 需要 QR 配对并在磁盘上存储更多状态。
- 群组行为因频道而异；参见[群组](/channels/groups)。
- 为安全起见，强制执行 DM 配对和允许列表；参见[安全](/gateway/security)。
- 故障排除：[频道故障排除](/channels/troubleshooting)。
- 模型提供商单独记录；参见[模型提供商](/providers/models)。