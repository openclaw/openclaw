---
summary: "Overblik over pairing: godkend hvem der kan sende dig DM’er + hvilke noder der kan tilsluttes"
read_when:
  - Opsætning af adgangskontrol for DM’er
  - Paring af en ny iOS/Android-node
  - Gennemgang af OpenClaws sikkerhedsprofil
title: "Pairing"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:53Z
---

# Pairing

“Pairing” er OpenClaws eksplicitte trin for **ejerens godkendelse**.
Det bruges to steder:

1. **DM-pairing** (hvem der må tale med botten)
2. **Node-pairing** (hvilke enheder/noder der må tilsluttes gateway-netværket)

Sikkerhedskontekst: [Security](/gateway/security)

## 1) DM-pairing (indgående chatadgang)

Når en kanal er konfigureret med DM-politik `pairing`, får ukendte afsendere en kort kode, og deres besked bliver **ikke behandlet**, før du godkender.

Standard DM-politikker er dokumenteret i: [Security](/gateway/security)

Pairing-koder:

- 8 tegn, store bogstaver, ingen tvetydige tegn (`0O1I`).
- **Udløber efter 1 time**. Botten sender kun pairing-beskeden, når en ny anmodning oprettes (cirka én gang i timen pr. afsender).
- Afventende DM-pairing-anmodninger er som standard begrænset til **3 pr. kanal**; yderligere anmodninger ignoreres, indtil én udløber eller bliver godkendt.

### Godkend en afsender

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Understøttede kanaler: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Hvor tilstanden gemmes

Gemmes under `~/.openclaw/credentials/`:

- Afventende anmodninger: `<channel>-pairing.json`
- Godkendt tilladelsesliste-lager: `<channel>-allowFrom.json`

Behandl disse som følsomme (de styrer adgangen til din assistent).

## 2) Node-enhedspairing (iOS/Android/macOS/headless-noder)

Noder forbinder til Gateway som **enheder** med `role: node`. Gateway
opretter en enhedspairing-anmodning, som skal godkendes.

### Godkend en node-enhed

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Lagring af node-pairing-tilstand

Gemmes under `~/.openclaw/devices/`:

- `pending.json` (kortlivet; afventende anmodninger udløber)
- `paired.json` (parrede enheder + tokens)

### Noter

- Den ældre `node.pair.*`-API (CLI: `openclaw nodes pending/approve`) er et separat, gateway-ejet pairing-lager. WS-noder kræver stadig enhedspairing.

## Relaterede dokumenter

- Sikkerhedsmodel + prompt injection: [Security](/gateway/security)
- Sikker opdatering (kør doctor): [Updating](/install/updating)
- Kanal-konfigurationer:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
