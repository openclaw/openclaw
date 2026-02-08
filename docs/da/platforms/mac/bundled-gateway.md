---
summary: "Gateway-runtime på macOS (ekstern launchd-tjeneste)"
read_when:
  - Pakning af OpenClaw.app
  - Fejlfinding af macOS gateway launchd-tjenesten
  - Installation af gateway CLI til macOS
title: "Gateway på macOS"
x-i18n:
  source_path: platforms/mac/bundled-gateway.md
  source_hash: 4a3e963d13060b12
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:25Z
---

# Gateway på macOS (ekstern launchd)

OpenClaw.app bundler ikke længere Node/Bun eller Gateway-runtime. macOS-appen
forventer en **ekstern** `openclaw` CLI-installation, starter ikke Gateway som en
underproces og administrerer en pr. bruger launchd-tjeneste for at holde Gateway
kørende (eller kobler sig til en eksisterende lokal Gateway, hvis en allerede
kører).

## Installér CLI (påkrævet for lokal tilstand)

Du skal bruge Node 22+ på Mac’en og derefter installere `openclaw` globalt:

```bash
npm install -g openclaw@<version>
```

macOS-appens **Install CLI**-knap kører samme flow via npm/pnpm (bun anbefales ikke til Gateway-runtime).

## Launchd (Gateway som LaunchAgent)

Etiket:

- `bot.molt.gateway` (eller `bot.molt.<profile>`; legacy `com.openclaw.*` kan forblive)

Plist-placering (pr. bruger):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (eller `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Administrator:

- macOS-appen ejer installation/opdatering af LaunchAgent i lokal tilstand.
- CLI’en kan også installere den: `openclaw gateway install`.

Adfærd:

- “OpenClaw Active” aktiverer/deaktiverer LaunchAgent.
- Lukning af appen stopper **ikke** gatewayen (launchd holder den i live).
- Hvis en Gateway allerede kører på den konfigurerede port, kobler appen sig til
  den i stedet for at starte en ny.

Logning:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Versionskompatibilitet

macOS-appen tjekker gateway-versionen mod sin egen version. Hvis de er
inkompatible, skal du opdatere den globale CLI, så den matcher app-versionen.

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Derefter:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
