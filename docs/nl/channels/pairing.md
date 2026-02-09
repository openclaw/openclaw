---
summary: "Overzicht van pairing: goedkeuren wie je een DM kan sturen + welke nodes kunnen deelnemen"
read_when:
  - DM-toegangsbeheer instellen
  - Een nieuwe iOS/Android-node koppelen
  - De beveiligingspositie van OpenClaw beoordelen
title: "Pairing"
---

# Pairing

“Pairing” is de expliciete stap voor **goedkeuring door de eigenaar** van OpenClaw.
Deze wordt op twee plekken gebruikt:

1. **DM-pairing** (wie met de bot mag praten)
2. **Node-pairing** (welke apparaten/nodes mogen deelnemen aan het gateway-netwerk)

Beveiligingscontext: [Security](/gateway/security)

## 1. DM-pairing (inkomende chattoegang)

Wanneer een kanaal is geconfigureerd met DM-beleid `pairing`, krijgen onbekende afzenders een korte code en wordt hun bericht **niet verwerkt** totdat je goedkeurt.

Standaard DM-beleiden zijn gedocumenteerd in: [Security](/gateway/security)

Pairingcodes:

- 8 tekens, hoofdletters, geen dubbelzinnige tekens (`0O1I`).
- **Verlopen na 1 uur**. De bot stuurt het pairingbericht alleen wanneer een nieuw verzoek wordt aangemaakt (ongeveer één keer per uur per afzender).
- Openstaande DM-pairingverzoeken zijn standaard beperkt tot **3 per kanaal**; extra verzoeken worden genegeerd totdat er één verloopt of wordt goedgekeurd.

### Een afzender goedkeuren

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Ondersteunde kanalen: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Waar de staat woont

Opgeslagen onder `~/.openclaw/credentials/`:

- Openstaande verzoeken: `<channel>-pairing.json`
- Goedgekeurde toegestane lijst: `<channel>-allowFrom.json`

Behandel deze als gevoelig (ze bepalen de toegang tot je assistent).

## 2. Node-apparaatpairing (iOS/Android/macOS/headless nodes)

Nodes verbinden met de Gateway als **apparaten** met `role: node`. De Gateway
maakt een apparaat-pairingverzoek aan dat moet worden goedgekeurd.

### Keur een node apparaat goed

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Opslag van node-pairingstatus

Opgeslagen onder `~/.openclaw/devices/`:

- `pending.json` (kortlevend; openstaande verzoeken verlopen)
- `paired.json` (gekoppelde apparaten + tokens)

### Notities

- De legacy `node.pair.*`-API (CLI: `openclaw nodes pending/approve`) is een
  aparte, gateway-eigen pairingopslag. WS-nodes vereisen nog steeds apparaatpairing.

## Gerelateerde documentatie

- Beveiligingsmodel + prompt injection: [Security](/gateway/security)
- Veilig bijwerken (run doctor): [Updating](/install/updating)
- Kanaalconfiguraties:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
