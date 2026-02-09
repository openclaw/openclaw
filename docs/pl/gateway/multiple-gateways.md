---
summary: "Uruchamianie wielu Gateway OpenClaw na jednym hoście (izolacja, porty i profile)"
read_when:
  - Uruchamianie więcej niż jednego Gateway na tej samej maszynie
  - Potrzebujesz izolowanych konfiguracji/stanu/portów dla każdego Gateway
title: "Wiele Gateway"
---

# Wiele Gateway (ten sam host)

Większość konfiguracji powinna używać jednego Gateway, ponieważ pojedynczy Gateway może obsługiwać wiele połączeń komunikatorów i agentów. Jeśli potrzebujesz silniejszej izolacji lub redundancji (np. bota ratunkowego), uruchom oddzielne Gateway z izolowanymi profilami/portami.

## Lista kontrolna izolacji (wymagane)

- `OPENCLAW_CONFIG_PATH` — plik konfiguracji na instancję
- `OPENCLAW_STATE_DIR` — sesje, poświadczenia i cache na instancję
- `agents.defaults.workspace` — katalog roboczy workspace na instancję
- `gateway.port` (lub `--port`) — unikalne dla każdej instancji
- Pochodne porty (przeglądarka/canvas) nie mogą się nakładać

Jeśli te zasoby są współdzielone, napotkasz wyścigi konfiguracji i konflikty portów.

## Zalecane: profile (`--profile`)

Profile automatycznie zakresują `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` i dodają sufiks do nazw usług.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Usługi per profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Przewodnik bota ratunkowego

Uruchom drugi Gateway na tym samym hoście z własnymi:

- profilem/konfiguracją
- katalog stanu
- workspace
- portem bazowym (plus porty pochodne)

Dzięki temu bot ratunkowy jest odizolowany od głównego bota i może diagnozować problemy lub stosować zmiany konfiguracji, gdy podstawowy bot jest niedostępny.

Odstęp portów: pozostaw co najmniej 20 portów między portami bazowymi, aby pochodne porty przeglądarki/canvas/CDP nigdy się nie zderzały.

### Jak zainstalować (bot ratunkowy)

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

## Mapowanie portów (pochodne)

Port bazowy = `gateway.port` (lub `OPENCLAW_GATEWAY_PORT` / `--port`).

- port usługi sterowania przeglądarką = baza + 2 (tylko local loopback)
- `canvasHost.port = base + 4`
- Porty CDP profilu przeglądarki są automatycznie alokowane z `browser.controlPort + 9 .. + 108`

Jeśli nadpiszesz którykolwiek z nich w konfiguracji lub zmiennych środowiskowych, musisz zachować ich unikalność dla każdej instancji.

## Uwagi dotyczące przeglądarki/CDP (częsta pułapka)

- **Nie** przypinaj `browser.cdpUrl` do tych samych wartości na wielu instancjach.
- Każda instancja potrzebuje własnego portu sterowania przeglądarką i zakresu CDP (pochodnego od portu gateway).
- Jeśli potrzebujesz jawnych portów CDP, ustaw `browser.profiles.<name>.cdpPort` per instancję.
- Zdalny Chrome: użyj `browser.profiles.<name>.cdpUrl` (per profil, per instancję).

## Przykład ręczny (env)

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Szybkie kontrole

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
