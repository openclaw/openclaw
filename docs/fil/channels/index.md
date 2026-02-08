---
summary: "Mga messaging platform na maaaring kumonekta ang OpenClaw"
read_when:
  - Gusto mong pumili ng chat channel para sa OpenClaw
  - Kailangan mo ng mabilis na pangkalahatang-ideya ng mga sinusuportahang messaging platform
title: "Mga Chat Channel"
x-i18n:
  source_path: channels/index.md
  source_hash: 6a0e2c70133776d3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:19Z
---

# Mga Chat Channel

Maaaring makipag-usap sa iyo ang OpenClaw sa anumang chat app na ginagamit mo na. Kumokonekta ang bawat channel sa pamamagitan ng Gateway.
Sinusuportahan ang text sa lahat; nag-iiba-iba ang media at reactions depende sa channel.

## Mga sinusuportahang channel

- [WhatsApp](/channels/whatsapp) — Pinakapopular; gumagamit ng Baileys at nangangailangan ng QR pairing.
- [Telegram](/channels/telegram) — Bot API sa pamamagitan ng grammY; sinusuportahan ang mga grupo.
- [Discord](/channels/discord) — Discord Bot API + Gateway; sinusuportahan ang mga server, channel, at DM.
- [Slack](/channels/slack) — Bolt SDK; mga app sa workspace.
- [Feishu](/channels/feishu) — Feishu/Lark bot sa pamamagitan ng WebSocket (plugin, hiwalay na ini-install).
- [Google Chat](/channels/googlechat) — Google Chat API app sa pamamagitan ng HTTP webhook.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; mga channel, grupo, DM (plugin, hiwalay na ini-install).
- [Signal](/channels/signal) — signal-cli; nakatuon sa privacy.
- [BlueBubbles](/channels/bluebubbles) — **Inirerekomenda para sa iMessage**; gumagamit ng BlueBubbles macOS server REST API na may buong suporta sa feature (edit, unsend, effects, reactions, pamamahala ng grupo — kasalukuyang sira ang edit sa macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Legacy na integrasyon sa macOS sa pamamagitan ng imsg CLI (deprecated, gamitin ang BlueBubbles para sa mga bagong setup).
- [Microsoft Teams](/channels/msteams) — Bot Framework; suporta para sa enterprise (plugin, hiwalay na ini-install).
- [LINE](/channels/line) — LINE Messaging API bot (plugin, hiwalay na ini-install).
- [Nextcloud Talk](/channels/nextcloud-talk) — Self-hosted na chat sa pamamagitan ng Nextcloud Talk (plugin, hiwalay na ini-install).
- [Matrix](/channels/matrix) — Matrix protocol (plugin, hiwalay na ini-install).
- [Nostr](/channels/nostr) — Decentralized na DM sa pamamagitan ng NIP-04 (plugin, hiwalay na ini-install).
- [Tlon](/channels/tlon) — Urbit-based na messenger (plugin, hiwalay na ini-install).
- [Twitch](/channels/twitch) — Twitch chat sa pamamagitan ng IRC connection (plugin, hiwalay na ini-install).
- [Zalo](/channels/zalo) — Zalo Bot API; sikat na messenger sa Vietnam (plugin, hiwalay na ini-install).
- [Zalo Personal](/channels/zalouser) — Zalo personal account sa pamamagitan ng QR login (plugin, hiwalay na ini-install).
- [WebChat](/web/webchat) — Gateway WebChat UI sa ibabaw ng WebSocket.

## Mga tala

- Maaaring tumakbo nang sabay-sabay ang mga channel; mag-configure ng marami at iruruta ng OpenClaw kada chat.
- Karaniwang pinakamabilis ang setup sa **Telegram** (simpleng bot token). Nangangailangan ang WhatsApp ng QR pairing at
  nag-iimbak ng mas maraming state sa disk.
- Nag-iiba ang behavior ng mga grupo depende sa channel; tingnan ang [Groups](/channels/groups).
- Ipinapatupad ang DM pairing at mga allowlist para sa kaligtasan; tingnan ang [Security](/gateway/security).
- Mga internal ng Telegram: [mga tala ng grammY](/channels/grammy).
- Pag-troubleshoot: [Pag-troubleshoot ng channel](/channels/troubleshooting).
- Hiwalay na dinodokumento ang mga model provider; tingnan ang [Model Providers](/providers/models).
