---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Messaging platforms OpenClaw can connect to"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to choose a chat channel for OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a quick overview of supported messaging platforms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Chat Channels"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Chat Channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can talk to you on any chat app you already use. Each channel connects via the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Text is supported everywhere; media and reactions vary by channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supported channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [WhatsApp](/channels/whatsapp) — Most popular; uses Baileys and requires QR pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Telegram](/channels/telegram) — Bot API via grammY; supports groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Discord](/channels/discord) — Discord Bot API + Gateway; supports servers, channels, and DMs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Slack](/channels/slack) — Bolt SDK; workspace apps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Feishu](/channels/feishu) — Feishu/Lark bot via WebSocket (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Google Chat](/channels/googlechat) — Google Chat API app via HTTP webhook.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; channels, groups, DMs (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Signal](/channels/signal) — signal-cli; privacy-focused.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [BlueBubbles](/channels/bluebubbles) — **Recommended for iMessage**; uses the BlueBubbles macOS server REST API with full feature support (edit, unsend, effects, reactions, group management — edit currently broken on macOS 26 Tahoe).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [iMessage (legacy)](/channels/imessage) — Legacy macOS integration via imsg CLI (deprecated, use BlueBubbles for new setups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Microsoft Teams](/channels/msteams) — Bot Framework; enterprise support (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [LINE](/channels/line) — LINE Messaging API bot (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nextcloud Talk](/channels/nextcloud-talk) — Self-hosted chat via Nextcloud Talk (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Matrix](/channels/matrix) — Matrix protocol (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nostr](/channels/nostr) — Decentralized DMs via NIP-04 (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tlon](/channels/tlon) — Urbit-based messenger (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Twitch](/channels/twitch) — Twitch chat via IRC connection (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnam's popular messenger (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Zalo Personal](/channels/zalouser) — Zalo personal account via QR login (plugin, installed separately).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [WebChat](/web/webchat) — Gateway WebChat UI over WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels can run simultaneously; configure multiple and OpenClaw will route per chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fastest setup is usually **Telegram** (simple bot token). WhatsApp requires QR pairing and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  stores more state on disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group behavior varies by channel; see [Groups](/channels/groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram internals: [grammY notes](/channels/grammy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Troubleshooting: [Channel troubleshooting](/channels/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model providers are documented separately; see [Model Providers](/providers/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
