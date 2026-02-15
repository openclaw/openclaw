---
summary: "OpenClaw 可以連接的訊息平台"
read_when:
  - 您想為 OpenClaw 選擇聊天頻道
  - 您需要快速了解支援的訊息平台
title: "聊天頻道"
---

# 聊天頻道

OpenClaw 可以透過您已使用的任何聊天應用程式與您對話。每個頻道都透過 Gateway 連接。
文字在所有地方都受支援；媒體和反應因頻道而異。

## 支援的頻道

- [WhatsApp](/channels/whatsapp) — 最受歡迎；使用 Baileys 並需要 QR 配對。
- [Telegram](/channels/telegram) — 透過 grammY 的 Bot API；支援群組。
- [Discord](/channels/discord) — Discord Bot API + Gateway；支援伺服器、頻道和私訊。
- [IRC](/channels/irc) — 經典 IRC 伺服器；頻道 + 帶有配對/允許列表控制的私訊。
- [Slack](/channels/slack) — Bolt SDK；工作區應用程式。
- [Feishu](/channels/feishu) — 透過 WebSocket 的 Feishu/Lark 機器人（插件，需單獨安裝）。
- [Google Chat](/channels/googlechat) — 透過 HTTP webhook 的 Google Chat API 應用程式。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；頻道、群組、私訊（插件，需單獨安裝）。
- [Signal](/channels/signal) — signal-cli；注重隱私。
- [BlueBubbles](/channels/bluebubbles) — **iMessage 推薦**；使用 BlueBubbles macOS 伺服器 REST API，支援完整功能（編輯、取消傳送、效果、反應、群組管理 — 目前 macOS 26 Tahoe 上的編輯功能已損壞）。
- [iMessage (舊版)](/channels/imessage) — 透過 imsg CLI 的舊版 macOS 整合（已棄用，新設置請使用 BlueBubbles）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企業支援（插件，需單獨安裝）。
- [LINE](/channels/line) — LINE Messaging API 機器人（插件，需單獨安裝）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 透過 Nextcloud Talk 的自架聊天（插件，需單獨安裝）。
- [Matrix](/channels/matrix) — Matrix 協定（插件，需單獨安裝）。
- [Nostr](/channels/nostr) — 透過 NIP-04 的去中心化私訊（插件，需單獨安裝）。
- [Tlon](/channels/tlon) — 基於 Urbit 的通訊軟體（插件，需單獨安裝）。
- [Twitch](/channels/twitch) — 透過 IRC 連線的 Twitch 聊天（插件，需單獨安裝）。
- [Zalo](/channels/zalo) — Zalo Bot API；越南流行的通訊軟體（插件，需單獨安裝）。
- [Zalo Personal](/channels/zalouser) — 透過 QR 登入的 Zalo 個人帳戶（插件，需單獨安裝）。
- [WebChat](/web/webchat) — 透過 WebSocket 的 Gateway WebChat UI。

## 備註

- 頻道可以同時運行；配置多個頻道後，OpenClaw 將根據聊天訊息進行路由。
- 最快的設定通常是 **Telegram**（簡單的機器人權杖）。WhatsApp 需要 QR 配對，並且
  在磁碟上儲存更多狀態。
- 群組行為因頻道而異；請參閱 [群組](/channels/groups)。
- 私訊配對和允許列表為了安全而強制執行；請參閱 [安全](/gateway/security)。
- Telegram 內部：[grammY 備註](/channels/grammy)。
- 疑難排解：[頻道疑難排解](/channels/troubleshooting)。
- 模型供應商另有文件說明；請參閱 [模型供應商](/providers/models)。
