---
summary: "Berichtplatforms waarmee OpenClaw kan verbinden"
read_when:
  - Je wilt een chatkanaal voor OpenClaw kiezen
  - Je hebt een snel overzicht nodig van ondersteunde berichtplatforms
title: "Chatkanalen"
---

# Chatkanalen

OpenClaw kan met je communiceren via elke chat-app die je al gebruikt. Elk kanaal verbindt via de Gateway.
Tekst wordt overal ondersteund; media en reacties verschillen per kanaal.

## Ondersteunde kanalen

- [WhatsApp](/channels/whatsapp) — Meest populair; gebruikt Baileys en vereist QR-koppeling.
- [Telegram](/channels/telegram) — Bot API via grammY; ondersteunt groepen.
- [Discord](/channels/discord) — Discord Bot API + Gateway; ondersteunt servers, kanalen en DM's.
- [Slack](/channels/slack) — Bolt SDK; werkruimte-apps.
- [Feishu](/channels/feishu) — Feishu/Lark-bot via WebSocket (plugin, afzonderlijk geïnstalleerd).
- [Google Chat](/channels/googlechat) — Google Chat API-app via HTTP-webhook.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; kanalen, groepen, DM's (plugin, afzonderlijk geïnstalleerd).
- [Signal](/channels/signal) — signal-cli; privacygericht.
- [BlueBubbles](/channels/bluebubbles) — **Aanbevolen voor iMessage**; gebruikt de BlueBubbles macOS-server REST API met volledige functiesteun (bewerken, intrekken, effecten, reacties, groepsbeheer — bewerken momenteel defect op macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Verouderde macOS-integratie via imsg CLI (verouderd; gebruik BlueBubbles voor nieuwe installaties).
- [Microsoft Teams](/channels/msteams) — Bot Framework; ondersteuning voor enterprises (plugin, afzonderlijk geïnstalleerd).
- [LINE](/channels/line) — LINE Messaging API-bot (plugin, afzonderlijk geïnstalleerd).
- [Nextcloud Talk](/channels/nextcloud-talk) — Zelfgehoste chat via Nextcloud Talk (plugin, afzonderlijk geïnstalleerd).
- [Matrix](/channels/matrix) — Matrix-protocol (plugin, afzonderlijk geïnstalleerd).
- [Nostr](/channels/nostr) — Gedecentraliseerde DM's via NIP-04 (plugin, afzonderlijk geïnstalleerd).
- [Tlon](/channels/tlon) — Urbit-gebaseerde messenger (plugin, afzonderlijk geïnstalleerd).
- [Twitch](/channels/twitch) — Twitch-chat via IRC-verbinding (plugin, afzonderlijk geïnstalleerd).
- [Zalo](/channels/zalo) — Zalo Bot API; populaire messenger in Vietnam (plugin, afzonderlijk geïnstalleerd).
- [Zalo Personal](/channels/zalouser) — Persoonlijk Zalo-account via QR-login (plugin, afzonderlijk geïnstalleerd).
- [WebChat](/web/webchat) — Gateway WebChat-UI via WebSocket.

## Notities

- Kanalen kunnen gelijktijdig draaien; configureer er meerdere en OpenClaw routeert per chat.
- De snelste installatie is meestal **Telegram** (eenvoudige bot-token). WhatsApp vereist QR-koppeling en
  slaat meer status op schijf op.
- Groepsgedrag verschilt per kanaal; zie [Groepen](/channels/groups).
- DM-koppeling en toegestane lijsten worden afgedwongen voor veiligheid; zie [Beveiliging](/gateway/security).
- Telegram-internals: [grammY-notities](/channels/grammy).
- Problemen oplossen: [Problemen met kanalen](/channels/troubleshooting).
- Modelproviders worden afzonderlijk gedocumenteerd; zie [Modelproviders](/providers/models).
