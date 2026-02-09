---
summary: "Meerdere OpenClaw Gateways op één host draaien (isolatie, poorten en profielen)"
read_when:
  - Meer dan één Gateway op dezelfde machine draaien
  - Je geïsoleerde config/toestand/poorten per Gateway nodig hebt
title: "Meerdere Gateways"
---

# Meerdere Gateways (zelfde host)

De meeste installaties gebruiken één Gateway, omdat één Gateway meerdere messagingverbindingen en agents kan afhandelen. Als je sterkere isolatie of redundantie nodig hebt (bijv. een reddingsbot), draai dan aparte Gateways met geïsoleerde profielen/poorten.

## Isolatiechecklist (vereist)

- `OPENCLAW_CONFIG_PATH` — configbestand per instantie
- `OPENCLAW_STATE_DIR` — sessies, referenties en caches per instantie
- `agents.defaults.workspace` — werkruimte-root per instantie
- `gateway.port` (of `--port`) — uniek per instantie
- Afgeleide poorten (browser/canvas) mogen niet overlappen

Als deze worden gedeeld, krijg je config-races en poortconflicten.

## Aanbevolen: profielen (`--profile`)

Profielen schalen automatisch `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` en voegen een suffix toe aan servicenamen.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Per-profiel services:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Reddingsbot-gids

Draai een tweede Gateway op dezelfde host met een eigen:

- profiel/config
- state-dir
- werkruimte
- basispoort (plus afgeleide poorten)

Dit houdt de reddingsbot geïsoleerd van de hoofd-bot, zodat deze kan debuggen of configwijzigingen kan toepassen als de primaire bot down is.

Poortafstand: laat minimaal 20 poorten tussen basispoorten zodat de afgeleide browser/canvas/CDP-poorten nooit botsen.

### Installeren (reddingsbot)

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

## Port mapping (afgeleid)

Basispoort = `gateway.port` (of `OPENCLAW_GATEWAY_PORT` / `--port`).

- poort voor browser-besturingsservice = basis + 2 (alleen loopback)
- `canvasHost.port = base + 4`
- Browserprofiel-CDP-poorten worden automatisch toegewezen vanaf `browser.controlPort + 9 .. + 108`

Als je een van deze overschrijft in config of env, moet je ze per instantie uniek houden.

## Browser/CDP-notities (veelvoorkomende valkuil)

- Zet `browser.cdpUrl` **niet** vast op dezelfde waarden voor meerdere instanties.
- Elke instantie heeft een eigen browser-besturingspoort en CDP-bereik nodig (afgeleid van de Gateway-poort).
- Als je expliciete CDP-poorten nodig hebt, stel `browser.profiles.<name>.cdpPort` per instantie in.
- Remote Chrome: gebruik `browser.profiles.<name>.cdpUrl` (per profiel, per instantie).

## Handmatig env-voorbeeld

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Snelle controles

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
