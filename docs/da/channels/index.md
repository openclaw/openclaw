---
summary: "Beskedplatforme som OpenClaw kan forbinde til"
read_when:
  - Du vil vælge en chatkanal til OpenClaw
  - Du har brug for et hurtigt overblik over understøttede beskedplatforme
title: "Chatkanaler"
---

# Chatkanaler

OpenClaw kan tale med dig på enhver chat app, du allerede bruger. Hver kanal forbinder via Gateway.
Tekst understøttes overalt; medier og reaktioner varierer fra kanal.

## Understøttede kanaler

- [WhatsApp](/channels/whatsapp) — Mest populær; bruger Baileys og kræver QR-parring.
- [Telegram](/channels/telegram) — Bot API via grammY; understøtter grupper.
- [Discord](/channels/discord) — Discord Bot API + Gateway; understøtter servere, kanaler og DM’er.
- [Slack](/channels/slack) — Bolt SDK; workspace-apps.
- [Feishu](/channels/feishu) — Feishu/Lark-bot via WebSocket (plugin, installeres separat).
- [Google Chat](/channels/googlechat) — Google Chat API-app via HTTP-webhook.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; kanaler, grupper, DM’er (plugin, installeres separat).
- [Signal](/channels/signal) — signal-cli; privatlivsfokuseret.
- [BlueBubbles](/channels/bluebubbles) — **Anbefalet til iMessage**; bruger BlueBubbles macOS-serverens REST API med fuld funktionsunderstøttelse (redigér, fortryd afsendelse, effekter, reaktioner, gruppestyring — redigering er i øjeblikket defekt på macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Ældre macOS-integration via imsg CLI (udfaset; brug BlueBubbles til nye opsætninger).
- [Microsoft Teams](/channels/msteams) — Bot Framework; enterprise-understøttelse (plugin, installeres separat).
- [LINE](/channels/line) — LINE Messaging API-bot (plugin, installeres separat).
- [Nextcloud Talk](/channels/nextcloud-talk) — Selvhostet chat via Nextcloud Talk (plugin, installeres separat).
- [Matrix](/channels/matrix) — Matrix-protokol (plugin, installeres separat).
- [Nostr](/channels/nostr) — Decentraliserede DM’er via NIP-04 (plugin, installeres separat).
- [Tlon](/channels/tlon) — Urbit-baseret messenger (plugin, installeres separat).
- [Twitch](/channels/twitch) — Twitch-chat via IRC-forbindelse (plugin, installeres separat).
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnams populære messenger (plugin, installeres separat).
- [Zalo Personal](/channels/zalouser) — Zalo personlig konto via QR-login (plugin, installeres separat).
- [WebChat](/web/webchat) — Gateway WebChat-UI over WebSocket.

## Noter

- Kanaler kan køre samtidigt; konfigurér flere, og OpenClaw ruter pr. chat.
- Hurtigste opsætning er normalt **Telegram** (simpel bot token). WhatsApp kræver QR-parring og
  gemmer mere status på disken.
- Gruppeadfærd varierer fra kanal til kanal; se [Grupper](/channels/groups).
- DM-parring og tilladelseslister håndhæves af hensyn til sikkerhed; se [Sikkerhed](/gateway/security).
- Telegram-internals: [grammY-noter](/channels/grammy).
- Fejlfinding: [Kanal-fejlfinding](/channels/troubleshooting).
- Modeludbydere dokumenteres separat; se [Modeludbydere](/providers/models).
