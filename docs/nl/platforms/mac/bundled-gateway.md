---
summary: "Gateway-runtime op macOS (externe launchd-service)"
read_when:
  - Verpakken van OpenClaw.app
  - Debuggen van de macOS Gateway launchd-service
  - Installeren van de Gateway CLI voor macOS
title: "Gateway op macOS"
---

# Gateway op macOS (externe launchd)

OpenClaw.app bundelt niet langer Node/Bun of de Gateway-runtime. De macOS-app
verwacht een **externe** `openclaw` CLI-installatie, start de Gateway niet als
childprocess en beheert een per‑gebruiker launchd-service om de Gateway
draaiend te houden (of koppelt aan een bestaande lokale Gateway als die al
actief is).

## De CLI installeren (vereist voor lokale modus)

Je hebt Node 22+ op de Mac nodig en installeert daarna `openclaw` globaal:

```bash
npm install -g openclaw@<version>
```

De knop **Install CLI** in de macOS-app voert dezelfde stappen uit via npm/pnpm (bun niet aanbevolen voor de Gateway-runtime).

## Launchd (Gateway als LaunchAgent)

Label:

- `bot.molt.gateway` (of `bot.molt.<profile>`; legacy `com.openclaw.*` kan blijven bestaan)

Plist-locatie (per gebruiker):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (of `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Beheer:

- De macOS-app beheert de installatie/update van de LaunchAgent in lokale modus.
- De CLI kan deze ook installeren: `openclaw gateway install`.

Gedrag:

- “OpenClaw Active” schakelt de LaunchAgent in/uit.
- Het afsluiten van de app stopt de Gateway **niet** (launchd houdt deze actief).
- Als er al een Gateway draait op de geconfigureerde poort, koppelt de app
  daaraan in plaats van een nieuwe te starten.

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Versiecompatibiliteit

De macOS-app controleert de Gateway-versie ten opzichte van zijn eigen versie. Als ze
niet compatibel zijn, werk de globale CLI bij zodat deze overeenkomt met de appversie.

## Rook schaak

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Daarna:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
