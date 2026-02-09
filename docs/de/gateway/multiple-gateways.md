---
summary: "Mehrere OpenClaw Gateways auf einem Host ausführen (Isolation, Ports und Profile)"
read_when:
  - Sie betreiben mehr als einen Gateway auf derselben Maschine
  - Sie benötigen isolierte Konfiguration/Zustand/Ports pro Gateway
title: "Mehrere Gateways"
---

# Mehrere Gateways (gleicher Host)

Die meisten Setups sollten einen Gateway verwenden, da ein einzelner Gateway mehrere Messaging-Verbindungen und Agenten verarbeiten kann. Wenn Sie stärkere Isolation oder Redundanz benötigen (z. B. einen Rettungs-Bot), betreiben Sie separate Gateways mit isolierten Profilen/Ports.

## Isolations-Checkliste (erforderlich)

- `OPENCLAW_CONFIG_PATH` — Konfigurationsdatei pro Instanz
- `OPENCLAW_STATE_DIR` — Sitzungen, Zugangsdaten, Caches pro Instanz
- `agents.defaults.workspace` — Workspace-Root pro Instanz
- `gateway.port` (oder `--port`) — pro Instanz eindeutig
- Abgeleitete Ports (Browser/Canvas) dürfen sich nicht überschneiden

Wenn diese geteilt werden, treten Konfigurations-Race-Conditions und Portkonflikte auf.

## Empfohlen: Profile (`--profile`)

Profile grenzen `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` automatisch ein und versehen Servicenamen mit Suffixen.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Services pro Profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Leitfaden für Rettungs-Bots

Betreiben Sie einen zweiten Gateway auf demselben Host mit jeweils eigener:

- Profil/Konfiguration
- state Verzeichnis
- Workspace
- Basis-Port (plus abgeleitete Ports)

So bleibt der Rettungs-Bot vom Haupt-Bot isoliert und kann debuggen oder Konfigurationsänderungen anwenden, falls der primäre Bot ausfällt.

Portabstand: Lassen Sie mindestens 20 Ports zwischen den Basis-Ports, damit die abgeleiteten Browser-/Canvas-/CDP-Ports nie kollidieren.

### Installation (Rettungs-Bot)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Portzuordnung (abgeleitet)

Basis-Port = `gateway.port` (oder `OPENCLAW_GATEWAY_PORT` / `--port`).

- Browser-Control-Service-Port = Basis + 2 (nur Loopback)
- `canvasHost.port = base + 4`
- Browserprofil-CDP-Ports werden automatisch aus `browser.controlPort + 9 .. + 108` zugewiesen

Wenn Sie einen dieser Werte in der Konfiguration oder über Umgebungsvariablen überschreiben, müssen sie pro Instanz eindeutig bleiben.

## Browser/CDP-Hinweise (häufige Fehlerquelle)

- **Nicht** `browser.cdpUrl` auf dieselben Werte bei mehreren Instanzen festlegen.
- Jede Instanz benötigt ihren eigenen Browser-Control-Port und CDP-Bereich (abgeleitet von ihrem Gateway-Port).
- Wenn Sie explizite CDP-Ports benötigen, setzen Sie `browser.profiles.<name>.cdpPort` pro Instanz.
- Remote-Chrome: Verwenden Sie `browser.profiles.<name>.cdpUrl` (pro Profil, pro Instanz).

## Manuelles env-Beispiel

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Schnelle Prüfungen

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
