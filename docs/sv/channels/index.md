---
summary: "Meddelandeplattformar som OpenClaw kan ansluta till"
read_when:
  - Du vill välja en chattkanal för OpenClaw
  - Du behöver en snabb översikt över stödda meddelandeplattformar
title: "Chattkanaler"
---

# Chattkanaler

OpenClaw kan prata med dig på vilken chatt som helst som du redan använder. Varje kanal ansluter via Gateway.
Texten stöds överallt; media och reaktioner varierar beroende på kanal.

## Stödda kanaler

- [WhatsApp](/channels/whatsapp) — Mest populär; använder Baileys och kräver QR‑parning.
- [Telegram](/channels/telegram) — Bot API via grammY; stöder grupper.
- [Discord](/channels/discord) — Discord Bot API + Gateway; stöder servrar, kanaler och DM.
- [Slack](/channels/slack) — Bolt SDK; appar för arbetsytor.
- [Feishu](/channels/feishu) — Feishu/Lark‑bot via WebSocket (plugin, installeras separat).
- [Google Chat](/channels/googlechat) — Google Chat API‑app via HTTP‑webhook.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; kanaler, grupper, DM (plugin, installeras separat).
- [Signal](/channels/signal) — signal-cli; integritetsfokuserad.
- [BlueBubbles](/channels/bluebubbles) — **Rekommenderad för iMessage**; använder BlueBubbles macOS‑serverns REST API med fullt funktionsstöd (redigera, ångra sändning, effekter, reaktioner, grupphantering — redigering är för närvarande trasig på macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Äldre macOS‑integration via imsg CLI (utfasad; använd BlueBubbles för nya installationer).
- [Microsoft Teams](/channels/msteams) — Bot Framework; stöd för företag (plugin, installeras separat).
- [LINE](/channels/line) — LINE Messaging API‑bot (plugin, installeras separat).
- [Nextcloud Talk](/channels/nextcloud-talk) — Självhostad chatt via Nextcloud Talk (plugin, installeras separat).
- [Matrix](/channels/matrix) — Matrix‑protokoll (plugin, installeras separat).
- [Nostr](/channels/nostr) — Decentraliserade DM via NIP‑04 (plugin, installeras separat).
- [Tlon](/channels/tlon) — Urbit‑baserad meddelandetjänst (plugin, installeras separat).
- [Twitch](/channels/twitch) — Twitch‑chatt via IRC‑anslutning (plugin, installeras separat).
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnams populära meddelandetjänst (plugin, installeras separat).
- [Zalo Personal](/channels/zalouser) — Zalo‑personligt konto via QR‑inloggning (plugin, installeras separat).
- [WebChat](/web/webchat) — Gateway WebChat‑UI över WebSocket.

## Noteringar

- Kanaler kan köras samtidigt; konfigurera flera så dirigerar OpenClaw per chatt.
- Snabbaste konfigurationen är vanligtvis **Telegram** (enkel bot token). WhatsApp kräver QR-parning och
  lagrar mer tillstånd på disken.
- Gruppbeteende varierar per kanal; se [Grupper](/channels/groups).
- DM‑parning och tillåtelselistor tillämpas av säkerhetsskäl; se [Säkerhet](/gateway/security).
- Telegram‑internals: [grammY‑noteringar](/channels/grammy).
- Felsökning: [Felsökning av kanaler](/channels/troubleshooting).
- Modellleverantörer dokumenteras separat; se [Modellleverantörer](/providers/models).
