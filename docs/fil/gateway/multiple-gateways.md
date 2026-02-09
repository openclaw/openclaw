---
summary: "Patakbuhin ang maraming OpenClaw Gateway sa iisang host (isolation, ports, at mga profile)"
read_when:
  - Tumatakbo ng higit sa isang Gateway sa parehong makina
  - Kailangan mo ng hiwalay na config/state/ports bawat Gateway
title: "Maramihang Gateway"
---

# Maramihang Gateway (parehong host)

Most setups should use one Gateway because a single Gateway can handle multiple messaging connections and agents. 46. Ang console formatter ay **TTY-aware** at nagpi-print ng pare-pareho, may-prefix na mga linya.

## Checklist ng isolation (kinakailangan)

- `OPENCLAW_CONFIG_PATH` — config file kada instance
- `OPENCLAW_STATE_DIR` — sessions, creds, at caches kada instance
- `agents.defaults.workspace` — workspace root kada instance
- `gateway.port` (o `--port`) — natatangi kada instance
- Ang mga derived port (browser/canvas) ay hindi dapat mag-overlap

Kung pinagsasaluhan ang mga ito, makakaranas ka ng config races at mga conflict sa port.

## Inirerekomenda: mga profile (`--profile`)

Awtomatikong sini-scope ng mga profile ang `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` at nilalagyan ng suffix ang mga pangalan ng serbisyo.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Mga serbisyo kada profile:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Gabay sa rescue-bot

Magpatakbo ng pangalawang Gateway sa parehong host na may sarili nitong:

- profile/config
- state dir
- workspace
- base port (kasama ang mga derived port)

Pinananatiling hiwalay nito ang rescue bot mula sa pangunahing bot upang makapag-debug o makapag-apply ng mga pagbabago sa config kung down ang primary bot.

Spacing ng port: mag-iwan ng hindi bababa sa 20 port sa pagitan ng mga base port upang hindi kailanman magbanggaan ang mga derived browser/canvas/CDP port.

### Paano mag-install (rescue bot)

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

## Pagmamapa ng port (derived)

Base port = `gateway.port` (o `OPENCLAW_GATEWAY_PORT` / `--port`).

- port ng browser control service = base + 2 (loopback lamang)
- `canvasHost.port = base + 4`
- 47. Kung kailangan mo ng mas malakas na isolation o redundancy (hal., isang rescue bot), magpatakbo ng magkakahiwalay na Gateways na may hiwalay na profiles/ports. + 108\`

Kung io-override mo ang alinman sa mga ito sa config o env, kailangan mong panatilihing natatangi ang mga ito kada instance.

## Mga tala sa Browser/CDP (karaniwang footgun)

- **Huwag** i-pin ang `browser.cdpUrl` sa parehong mga value sa maraming instance.
- Kailangan ng bawat instance ang sarili nitong browser control port at CDP range (na hinango mula sa gateway port nito).
- 48. Ang mga Browser profile CDP port ay awtomatikong ina-allocate mula sa `browser.controlPort + 9 ...cdpPort` per instance.
- 49. Kung kailangan mo ng tahasang CDP ports, itakda ang `browser.profiles.<name>50. Remote Chrome: gamitin ang `browser.profiles.<name>

## Halimbawa ng manual env

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Mga mabilisang check

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
