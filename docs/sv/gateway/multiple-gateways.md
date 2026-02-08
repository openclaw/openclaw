---
summary: "Kör flera OpenClaw Gateways på en värd (isolering, portar och profiler)"
read_when:
  - Köra mer än en Gateway på samma maskin
  - Du behöver isolerad konfig/tilstånd/portar per Gateway
title: "Flera Gateways"
x-i18n:
  source_path: gateway/multiple-gateways.md
  source_hash: 09b5035d4e5fb97c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:18Z
---

# Flera Gateways (samma värd)

De flesta uppsättningar bör använda en Gateway eftersom en enda Gateway kan hantera flera meddelandeanslutningar och agenter. Om du behöver starkare isolering eller redundans (t.ex. en räddningsbot) kan du köra separata Gateways med isolerade profiler/portar.

## Isoleringschecklista (krävs)

- `OPENCLAW_CONFIG_PATH` — konfigfil per instans
- `OPENCLAW_STATE_DIR` — sessioner, autentiseringsuppgifter och cache per instans
- `agents.defaults.workspace` — arbetsyterot per instans
- `gateway.port` (eller `--port`) — unikt per instans
- Härledda portar (browser/canvas) får inte överlappa

Om dessa delas får du konfiglopp och portkonflikter.

## Rekommenderat: profiler (`--profile`)

Profiler avgränsar automatiskt `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` och suffixerar tjänstnamn.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Tjänster per profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guide för räddningsbot

Kör en andra Gateway på samma värd med egna:

- profil/konfig
- tillståndskatalog
- arbetsyta
- basport (plus härledda portar)

Detta håller räddningsboten isolerad från huvudboten så att den kan felsöka eller tillämpa konfigändringar om primärboten är nere.

Portavstånd: lämna minst 20 portar mellan basportar så att de härledda browser-/canvas-/CDP-portarna aldrig krockar.

### Så installerar du (räddningsbot)

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

## Portmappning (härledd)

Basport = `gateway.port` (eller `OPENCLAW_GATEWAY_PORT` / `--port`).

- port för browser control-tjänsten = bas + 2 (endast loopback)
- `canvasHost.port = base + 4`
- CDP-portar för browserprofiler allokeras automatiskt från `browser.controlPort + 9 .. + 108`

Om du åsidosätter någon av dessa i konfig eller miljövariabler måste du hålla dem unika per instans.

## Browser/CDP-noteringar (vanlig fallgrop)

- **Fäst inte** `browser.cdpUrl` till samma värden på flera instanser.
- Varje instans behöver egen browser control-port och CDP-intervall (härlett från dess gateway-port).
- Om du behöver explicita CDP-portar, sätt `browser.profiles.<name>.cdpPort` per instans.
- Fjärr-Chrome: använd `browser.profiles.<name>.cdpUrl` (per profil, per instans).

## Manuellt env-exempel

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Snabba kontroller

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
