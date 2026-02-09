---
summary: "Messaging-Plattformen, mit denen OpenClaw sich verbinden kann"
read_when:
  - Sie möchten einen Chat-Kanal für OpenClaw auswählen
  - Sie benötigen einen schnellen Überblick über unterstützte Messaging-Plattformen
title: "Chat-Kanäle"
---

# Chat-Kanäle

OpenClaw kann mit Ihnen über jede Chat-App sprechen, die Sie bereits nutzen. Jeder Kanal verbindet sich über das Gateway.
Text wird überall unterstützt; Medien und Reaktionen variieren je nach Kanal.

## Unterstützte Kanäle

- [WhatsApp](/channels/whatsapp) — Am beliebtesten; verwendet Baileys und erfordert QR-Kopplung.
- [Telegram](/channels/telegram) — Bot-API über grammY; unterstützt Gruppen.
- [Discord](/channels/discord) — Discord Bot API + Gateway; unterstützt Server, Kanäle und Direktnachrichten.
- [Slack](/channels/slack) — Bolt SDK; Workspace-Apps.
- [Feishu](/channels/feishu) — Feishu/Lark-Bot über WebSocket (Plugin, separat installiert).
- [Google Chat](/channels/googlechat) — Google-Chat-API-App über HTTP-Webhook.
- [Mattermost](/channels/mattermost) — Bot-API + WebSocket; Kanäle, Gruppen, Direktnachrichten (Plugin, separat installiert).
- [Signal](/channels/signal) — signal-cli; datenschutzorientiert.
- [BlueBubbles](/channels/bluebubbles) — **Empfohlen für iMessage**; verwendet die BlueBubbles-macOS-Server-REST-API mit vollständiger Funktionsunterstützung (Bearbeiten, Zurückziehen, Effekte, Reaktionen, Gruppenverwaltung — Bearbeiten derzeit unter macOS 26 Tahoe defekt).
- [iMessage (legacy)](/channels/imessage) — Legacy-macOS-Integration über imsg CLI (veraltet, für neue Setups BlueBubbles verwenden).
- [Microsoft Teams](/channels/msteams) — Bot Framework; Enterprise-Unterstützung (Plugin, separat installiert).
- [LINE](/channels/line) — LINE Messaging API-Bot (Plugin, separat installiert).
- [Nextcloud Talk](/channels/nextcloud-talk) — Selbstgehosteter Chat über Nextcloud Talk (Plugin, separat installiert).
- [Matrix](/channels/matrix) — Matrix-Protokoll (Plugin, separat installiert).
- [Nostr](/channels/nostr) — Dezentrale Direktnachrichten über NIP-04 (Plugin, separat installiert).
- [Tlon](/channels/tlon) — Urbit-basierter Messenger (Plugin, separat installiert).
- [Twitch](/channels/twitch) — Twitch-Chat über IRC-Verbindung (Plugin, separat installiert).
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnams beliebter Messenger (Plugin, separat installiert).
- [Zalo Personal](/channels/zalouser) — Zalo-Privatkonto über QR-Login (Plugin, separat installiert).
- [WebChat](/web/webchat) — Gateway-WebChat-UI über WebSocket.

## Hinweise

- Kanäle können gleichzeitig laufen; konfigurieren Sie mehrere, und OpenClaw routet pro Chat.
- Der schnellste Einstieg ist meist **Telegram** (einfacher Bot-Token). WhatsApp erfordert QR-Kopplung und
  speichert mehr Zustand auf der Festplatte.
- Das Gruppenverhalten variiert je nach Kanal; siehe [Groups](/channels/groups).
- DM-Kopplung und Allowlists werden aus Sicherheitsgründen durchgesetzt; siehe [Security](/gateway/security).
- Telegram-Interna: [grammY-Hinweise](/channels/grammy).
- Fehlerbehebung: [Kanal-Fehlerbehebung](/channels/troubleshooting).
- Modellanbieter sind separat dokumentiert; siehe [Model Providers](/providers/models).
