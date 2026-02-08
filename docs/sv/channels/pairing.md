---
summary: "Översikt av parning: godkänn vem som kan DM:a dig + vilka noder som kan ansluta"
read_when:
  - Konfigurera åtkomstkontroll för DM
  - Para en ny iOS-/Android-nod
  - Granska OpenClaws säkerhetsläge
title: "Parning"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:24Z
---

# Parning

”Parning” är OpenClaws explicita steg för **ägargodkännande**.
Det används på två ställen:

1. **DM-parning** (vem som får prata med boten)
2. **Nodparning** (vilka enheter/noder som får ansluta till gateway-nätverket)

Säkerhetskontext: [Security](/gateway/security)

## 1) DM-parning (inkommande chattåtkomst)

När en kanal är konfigurerad med DM-policy `pairing` får okända avsändare en kort kod och deras meddelande **behandlas inte** förrän du godkänner.

Standard-DM-policyer dokumenteras i: [Security](/gateway/security)

Parningskoder:

- 8 tecken, versaler, inga tvetydiga tecken (`0O1I`).
- **Går ut efter 1 timme**. Boten skickar bara parningsmeddelandet när en ny begäran skapas (ungefär en gång per timme per avsändare).
- Väntande DM-parningsbegäranden är som standard begränsade till **3 per kanal**; ytterligare begäranden ignoreras tills en går ut eller godkänns.

### Godkänn en avsändare

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Stödda kanaler: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Var tillståndet lagras

Lagring under `~/.openclaw/credentials/`:

- Väntande begäranden: `<channel>-pairing.json`
- Godkänd tillåtelselista: `<channel>-allowFrom.json`

Behandla dessa som känsliga (de styr åtkomsten till din assistent).

## 2) Nod-/enhetsparning (iOS/Android/macOS/headless-noder)

Noder ansluter till Gateway som **enheter** med `role: node`. Gateway
skapar en enhetsparningsbegäran som måste godkännas.

### Godkänn en nodenhet

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Lagring av nodparningstillstånd

Lagring under `~/.openclaw/devices/`:

- `pending.json` (kortlivad; väntande begäranden går ut)
- `paired.json` (parade enheter + token)

### Noteringar

- Det äldre `node.pair.*`-API:t (CLI: `openclaw nodes pending/approve`) är en
  separat, gateway-ägd parningslagring. WS-noder kräver fortfarande enhetsparning.

## Relaterad dokumentation

- Säkerhetsmodell + promptinjektion: [Security](/gateway/security)
- Uppdatera säkert (kör doctor): [Updating](/install/updating)
- Kanal-konfigurationer:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
