---
summary: Messaging platforms OpenClaw can connect to
read_when:
  - You want to choose a chat channel for OpenClaw
  - You need a quick overview of supported messaging platforms
title: Chat Channels
---

# Chat Channels

OpenClaw 可以在您已經使用的任何聊天應用程式上與您對話。每個頻道都通過 Gateway 連接。文字在所有地方都受到支援；媒體和反應則因頻道而異。

## 支援的通道

- [BlueBubbles](/channels/bluebubbles) — **推薦用於 iMessage**；使用 BlueBubbles macOS 伺服器 REST API，支援完整功能（編輯、撤回、特效、反應、群組管理 — 目前在 macOS 26 Tahoe 上編輯功能損壞）。
- [Discord](/channels/discord) — Discord Bot API + Gateway；支援伺服器、頻道和私訊。
- [Feishu](/channels/feishu) — 透過 WebSocket 的 Feishu/Lark 機器人（插件，需單獨安裝）。
- [Google Chat](/channels/googlechat) — 透過 HTTP webhook 的 Google Chat API 應用程式。
- [iMessage (legacy)](/channels/imessage) — 透過 imsg CLI 的舊版 macOS 整合（已棄用，對於新設置請使用 BlueBubbles）。
- [IRC](/channels/irc) — 經典 IRC 伺服器；頻道 + 私訊，具備配對/允許清單控制。
- [LINE](/channels/line) — LINE Messaging API 機器人（插件，需單獨安裝）。
- [Matrix](/channels/matrix) — Matrix 協議（插件，需單獨安裝）。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；頻道、群組、私訊（插件，需單獨安裝）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企業支援（插件，需單獨安裝）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 透過 Nextcloud Talk 的自我託管聊天（插件，需單獨安裝）。
- [Nostr](/channels/nostr) — 透過 NIP-04 的去中心化私訊（插件，需單獨安裝）。
- [Signal](/channels/signal) — signal-cli；以隱私為重點。
- [Synology Chat](/channels/synology-chat) — 透過外發+內收 webhook 的 Synology NAS 聊天（插件，需單獨安裝）。
- [Slack](/channels/slack) — Bolt SDK；工作區應用程式。
- [Telegram](/channels/telegram) — 透過 grammY 的 Bot API；支援群組。
- [Tlon](/channels/tlon) — 基於 Urbit 的即時通訊軟體（插件，需單獨安裝）。
- [Twitch](/channels/twitch) — 透過 IRC 連接的 Twitch 聊天（插件，需單獨安裝）。
- [WebChat](/web/webchat) — 透過 WebSocket 的 Gateway WebChat UI。
- [WhatsApp](/channels/whatsapp) — 最受歡迎；使用 Baileys 並需要 QR 配對。
- [Zalo](/channels/zalo) — Zalo Bot API；越南流行的即時通訊軟體（插件，需單獨安裝）。
- [Zalo Personal](/channels/zalouser) — 透過 QR 登入的 Zalo 個人帳戶（插件，需單獨安裝）。

## Notes

- 頻道可以同時執行；設定多個頻道，OpenClaw 將根據聊天進行路由。
- 最快速的設置通常是 **Telegram**（簡單的機器人 token）。WhatsApp 需要 QR 配對，並在磁碟上儲存更多狀態。
- 群組行為因頻道而異；請參見 [Groups](/channels/groups)。
- DM 配對和允許清單是為了安全性而強制執行的；請參見 [Security](/gateway/security)。
- 疑難排解： [Channel troubleshooting](/channels/troubleshooting)。
- 模型提供者的文檔是單獨記錄的；請參見 [Model Providers](/providers/models)。
