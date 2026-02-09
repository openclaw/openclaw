---
summary: "OpenClaw 可連接的即時通訊平台"
read_when:
  - 你想為 OpenClaw 選擇一個聊天頻道
  - 你需要快速概覽支援的即時通訊平台
title: "聊天頻道"
---

# 聊天頻道

OpenClaw 可以在你已經使用的任何聊天應用程式上與你對話。每個頻道都透過 Gateway 閘道器 連線。
各頻道皆支援文字；媒體與反應功能會依頻道而有所差異。 Each channel connects via the Gateway.
Text is supported everywhere; media and reactions vary by channel.

## 支援的頻道

- [WhatsApp](/channels/whatsapp) — 最受歡迎；使用 Baileys，並需要 QR 配對。
- [Telegram](/channels/telegram) — 透過 grammY 的 Bot API；支援群組。
- [Discord](/channels/discord) — Discord Bot API + Gateway 閘道器；支援伺服器、頻道與私訊。
- [Slack](/channels/slack) — Bolt SDK；工作區應用程式。
- [Feishu](/channels/feishu) — 透過 WebSocket 的 Feishu/Lark 機器人（外掛，需另行安裝）。
- [Google Chat](/channels/googlechat) — 透過 HTTP webhook 的 Google Chat API 應用程式。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；頻道、群組、私訊（外掛，需另行安裝）。
- [Signal](/channels/signal) — signal-cli；以隱私為導向。
- [BlueBubbles](/channels/bluebubbles) — **iMessage 的推薦選項**；使用 BlueBubbles macOS 伺服器的 REST API，具備完整功能支援（編輯、收回、效果、反應、群組管理 — 目前在 macOS 26 Tahoe 上編輯功能故障）。
- [iMessage (legacy)](/channels/imessage) — 透過 imsg CLI 的舊版 macOS 整合（已淘汰，新安裝請使用 BlueBubbles）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企業級支援（外掛，需另行安裝）。
- [LINE](/channels/line) — LINE Messaging API 機器人（外掛，需另行安裝）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 透過 Nextcloud Talk 的自架聊天（外掛，需另行安裝）。
- [Matrix](/channels/matrix) — Matrix protocol (plugin, installed separately).
- [Nostr](/channels/nostr) — 透過 NIP-04 的去中心化私訊（外掛，需另行安裝）。
- [Tlon](/channels/tlon) — 基於 Urbit 的即時通訊器（外掛，需另行安裝）。
- [Twitch](/channels/twitch) — 透過 IRC 連線的 Twitch 聊天（外掛，需另行安裝）。
- [Zalo](/channels/zalo) — Zalo Bot API；越南的熱門即時通訊（外掛，需另行安裝）。
- [Zalo Personal](/channels/zalouser) — 透過 QR 登入的 Zalo 個人帳號（外掛，需另行安裝）。
- [WebChat](/web/webchat) — 透過 WebSocket 的 Gateway WebChat UI。

## 注意事項

- 頻道可以同時執行；設定多個後，OpenClaw 會依聊天進行路由。
- Fastest setup is usually **Telegram** (simple bot token). 最快的設定方式通常是 **Telegram**（簡單的 Bot 權杖）。WhatsApp 需要 QR 配對，並
  會在磁碟上儲存較多狀態。
- 群組行為依頻道而異；請參閱 [Groups](/channels/groups)。
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).
- Telegram 內部細節：[grammY notes](/channels/grammy)。
- 疑難排解：[Channel troubleshooting](/channels/troubleshooting)。
- 模型提供者另有文件說明；請參閱 [Model Providers](/providers/models)。
