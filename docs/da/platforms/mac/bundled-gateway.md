---
summary: "Gateway-runtime på macOS (ekstern launchd-tjeneste)"
read_when:
  - Pakning af OpenClaw.app
  - Fejlfinding af macOS gateway launchd-tjenesten
  - Installation af gateway CLI til macOS
title: "Gateway på macOS"
---

# Gateway på macOS (ekstern launchd)

OpenClaw.app har ikke længere bundles Node/Bun eller Gateway runtime. MacOS app
forventer en **eksternt** 'openclaw' CLI installation, spawner ikke Gateway som en
-børneproces, og administrerer en per-user launchd service til at holde Gateway
kører (eller tillægger en eksisterende lokal Gateway hvis en allerede kører).

## Installér CLI (påkrævet for lokal tilstand)

Du skal bruge Node 22+ på Mac’en og derefter installere `openclaw` globalt:

```bash
npm install -g openclaw@<version>
```

macOS-appens **Install CLI**-knap kører samme flow via npm/pnpm (bun anbefales ikke til Gateway-runtime).

## Launchd (Gateway som LaunchAgent)

Etiket:

- `bot.molt.gateway` (or `bot.molt.<profile>`; arv `com.openclaw.*` kan være tilbage)

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

MacOS app kontrollerer gatewayversionen mod sin egen version. Hvis de er
uforenelige, skal du opdatere den globale CLI til at matche app-versionen.

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
