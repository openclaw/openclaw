---
summary: "Kør flere OpenClaw Gateways på én vært (isolering, porte og profiler)"
read_when:
  - Kørsel af mere end én Gateway på den samme maskine
  - Du har brug for isoleret konfiguration/tilstand/porte pr. Gateway
title: "Flere Gateways"
x-i18n:
  source_path: gateway/multiple-gateways.md
  source_hash: 09b5035d4e5fb97c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:15Z
---

# Flere Gateways (samme vært)

De fleste opsætninger bør bruge én Gateway, fordi en enkelt Gateway kan håndtere flere messaging-forbindelser og agenter. Hvis du har brug for stærkere isolering eller redundans (f.eks. en redningsbot), kan du køre separate Gateways med isolerede profiler/porte.

## Isolerings-tjekliste (påkrævet)

- `OPENCLAW_CONFIG_PATH` — konfigurationsfil pr. instans
- `OPENCLAW_STATE_DIR` — sessions, legitimationsoplysninger og caches pr. instans
- `agents.defaults.workspace` — arbejdsområde-rod pr. instans
- `gateway.port` (eller `--port`) — unikt pr. instans
- Afledte porte (browser/canvas) må ikke overlappe

Hvis disse deles, vil du få konfigurationsræs og portkonflikter.

## Anbefalet: profiler (`--profile`)

Profiler afgrænser automatisk `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` og tilføjer suffiks til tjenestenavne.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Tjenester pr. profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guide til redningsbot

Kør en anden Gateway på den samme vært med sin egen:

- profil/konfiguration
- tilstandskatalog
- arbejdsområde
- basisport (plus afledte porte)

Dette holder redningsbotten isoleret fra hovedbotten, så den kan fejlsøge eller anvende konfigurationsændringer, hvis den primære bot er nede.

Portafstand: lad mindst 20 porte være mellem basisporte, så de afledte browser/canvas/CDP-porte aldrig kolliderer.

### Sådan installerer du (redningsbot)

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

## Portmapping (afledt)

Basisport = `gateway.port` (eller `OPENCLAW_GATEWAY_PORT` / `--port`).

- browserkontroltjeneste-port = basis + 2 (kun loopback)
- `canvasHost.port = base + 4`
- Browserprofil-CDP-porte allokeres automatisk fra `browser.controlPort + 9 .. + 108`

Hvis du tilsidesætter nogen af disse i konfiguration eller miljøvariabler, skal du holde dem unikke pr. instans.

## Browser/CDP-noter (almindelig faldgrube)

- Fastlås **ikke** `browser.cdpUrl` til de samme værdier på flere instanser.
- Hver instans kræver sin egen browserkontrolport og CDP-interval (afledt af dens gateway-port).
- Hvis du har brug for eksplicitte CDP-porte, skal du sætte `browser.profiles.<name>.cdpPort` pr. instans.
- Fjern-Chrome: brug `browser.profiles.<name>.cdpUrl` (pr. profil, pr. instans).

## Manuel env-eksempel

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Hurtige tjek

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
