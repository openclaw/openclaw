---
summary: "Gateway-körning på macOS (extern launchd-tjänst)"
read_when:
  - Paketering av OpenClaw.app
  - Felsökning av macOS gateway launchd-tjänsten
  - Installera gateway CLI för macOS
title: "Gateway på macOS"
x-i18n:
  source_path: platforms/mac/bundled-gateway.md
  source_hash: 4a3e963d13060b12
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:54Z
---

# Gateway på macOS (extern launchd)

OpenClaw.app paketerar inte längre Node/Bun eller Gateway‑körningen. macOS‑appen
förutsätter en **extern** `openclaw` CLI‑installation, startar inte Gateway som en
underprocess och hanterar en launchd‑tjänst per användare för att hålla Gateway
igång (eller ansluter till en befintlig lokal Gateway om en redan körs).

## Installera CLI (krävs för lokalt läge)

Du behöver Node 22+ på Macen och installerar sedan `openclaw` globalt:

```bash
npm install -g openclaw@<version>
```

macOS‑appens knapp **Install CLI** kör samma flöde via npm/pnpm (bun rekommenderas inte för Gateway‑körning).

## Launchd (Gateway som LaunchAgent)

Etikett:

- `bot.molt.gateway` (eller `bot.molt.<profile>`; äldre `com.openclaw.*` kan finnas kvar)

Plist‑plats (per användare):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (eller `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Hantering:

- macOS‑appen äger installation/uppdatering av LaunchAgent i lokalt läge.
- CLI kan också installera den: `openclaw gateway install`.

Beteende:

- ”OpenClaw Active” aktiverar/inaktiverar LaunchAgent.
- Att avsluta appen stoppar **inte** gatewayn (launchd håller den vid liv).
- Om en Gateway redan körs på den konfigurerade porten ansluter appen till den
  i stället för att starta en ny.

Loggning:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Versionskompatibilitet

macOS‑appen kontrollerar gateway‑versionen mot sin egen version. Om de är
inkompatibla uppdaterar du den globala CLI:n så att den matchar appversionen.

## Snabbkontroll

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Sedan:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
