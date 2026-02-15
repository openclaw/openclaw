---
summary: "OpenClaw 可以連線的通訊平台"
read_when:
  - 您想為 OpenClaw 選擇聊天頻道
  - 您需要了解支援通訊平台的快速總覽
title: "聊天頻道"
---

# 聊天頻道

OpenClaw 可以透過您已在使用的任何聊天應用程式與您交流。每個頻道都透過 Gateway 進行連線。
所有平台皆支援文字；媒體與表情回應則因頻道而異。

## 支援的頻道

- [WhatsApp](/channels/whatsapp) — 最受歡迎；使用 Baileys 並需要透過 QR code 配對。
- [Telegram](/channels/telegram) — 透過 grammY 使用 Bot API；支援群組。
- [Discord](/channels/discord) — Discord Bot API + Gateway；支援伺服器、頻道與私訊。
- [IRC](/channels/irc) — 經典 IRC 伺服器；包含頻道與私訊，具備配對/允許列表控制。
- [Slack](/channels/slack) — Bolt SDK；工作區應用程式。
- [Feishu](/channels/feishu) — 透過 WebSocket 運作的飛書 (Feishu)/Lark 機器人（外掛程式，需另行安裝）。
- [Google Chat](/channels/googlechat) — 透過 HTTP webhook 的 Google Chat API 應用程式。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；支援頻道、群組、私訊（外掛程式，需另行安裝）。
- [Signal](/channels/signal) — signal-cli；注重隱私。
- [BlueBubbles](/channels/bluebubbles) — **iMessage 推薦方案**；使用 BlueBubbles macOS 伺服器 REST API，支援完整功能（編輯、取消傳送、特效、表情回應、群組管理 —— 編輯功能目前在 macOS 26 Tahoe 上無法運作）。
- [iMessage (legacy)](/channels/imessage) — 透過 imsg CLI 的舊版 macOS 整合（已棄用，新設定請使用 BlueBubbles）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；企業級支援（外掛程式，需另行安裝）。
- [LINE](/channels/line) — LINE Messaging API 機器人（外掛程式，需另行安裝）。
- [Nextcloud Talk](/channels/nextcloud-talk) — 透過 Nextcloud Talk 的自代管聊天（外掛程式，需另行安裝）。
- [Matrix](/channels/matrix) — Matrix 協定（外掛程式，需另行安裝）。
- [Nostr](/channels/nostr) — 透過 NIP-04 的去中心化私訊（外掛程式，需另行安裝）。
- [Tlon](/channels/tlon) — 基於 Urbit 的通訊軟體（外掛程式，需另行安裝）。
- [Twitch](/channels/twitch) — 透過 IRC 連線的 Twitch 聊天（外掛程式，需另行安裝）。
- [Zalo](/channels/zalo) — Zalo Bot API；越南熱門的通訊軟體（外掛程式，需另行安裝）。
- [Zalo Personal](/channels/zalouser) — 透過 QR code 登入的 Zalo 個人帳號（外掛程式，需另行安裝）。
- [WebChat](/web/webchat) — 透過 WebSocket 的 Gateway WebChat UI。

## 注意事項

- 頻道可以同時執行；設定多個頻道後，OpenClaw 會根據各別對話進行路由。
- 通常最快的設定方式是 **Telegram**（只需簡單的 bot token）。WhatsApp 需要 QR code 配對，且會在磁碟上儲存更多狀態。
- 群組行為因頻道而異；請參閱[群組](/channels/groups)。
- 為了安全起見，強制執行私訊配對與允許列表；請參閱[安全性](/gateway/security)。
- Telegram 內部機制：[grammY 說明](/channels/grammy)。
- 疑難排解：[頻道疑難排解](/channels/troubleshooting)。
- 模型供應商有獨立的文件說明；請參閱[模型供應商](/providers/models)。
