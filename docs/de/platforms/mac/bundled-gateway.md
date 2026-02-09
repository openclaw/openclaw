---
summary: "„Gateway-Laufzeitumgebung unter macOS (externer launchd‑Dienst)“"
read_when:
  - „OpenClaw.app paketieren“
  - „Den macOS‑Gateway‑launchd‑Dienst debuggen“
  - „Die Gateway‑CLI für macOS installieren“
title: "„Gateway unter macOS“"
---

# Gateway unter macOS (externer launchd)

OpenClaw.app bündelt Node/Bun oder die Gateway‑Laufzeitumgebung nicht mehr. Die macOS‑App
erwartet eine **externe** `openclaw`‑CLI‑Installation, startet das Gateway nicht als
Kindprozess und verwaltet einen benutzerspezifischen launchd‑Dienst, um das Gateway
am Laufen zu halten (oder verbindet sich mit einem bestehenden lokalen Gateway, falls bereits eines läuft).

## Die CLI installieren (erforderlich für den lokalen Modus)

Sie benötigen Node 22+ auf dem Mac und installieren anschließend `openclaw` global:

```bash
npm install -g openclaw@<version>
```

Die **Install CLI**‑Schaltfläche der macOS‑App führt denselben Ablauf über npm/pnpm aus (bun wird für die Gateway‑Laufzeitumgebung nicht empfohlen).

## Launchd (Gateway als LaunchAgent)

Label:

- `bot.molt.gateway` (oder `bot.molt.<profile>`; das veraltete `com.openclaw.*` kann bestehen bleiben)

Plist‑Speicherort (pro Benutzer):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (oder `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Verwaltung:

- Die macOS‑App ist im lokalen Modus für Installation/Aktualisierung des LaunchAgent zuständig.
- Die CLI kann ihn ebenfalls installieren: `openclaw gateway install`.

Verhalten:

- „OpenClaw Active“ aktiviert/deaktiviert den LaunchAgent.
- Das Beenden der App stoppt das Gateway **nicht** (launchd hält es aktiv).
- Wenn auf dem konfigurierten Port bereits ein Gateway läuft, verbindet sich die App damit,
  anstatt ein neues zu starten.

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Versionskompatibilität

Die macOS‑App prüft die Gateway‑Version gegen ihre eigene Version. Wenn sie
inkompatibel sind, aktualisieren Sie die globale CLI, damit sie zur App‑Version passt.

## Smoke‑Check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Dann:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
