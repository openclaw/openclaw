---
summary: "CLI-reference for `openclaw config` (hent/angiv/fjern konfigurationsværdier)"
read_when:
  - Du vil læse eller redigere konfiguration ikke-interaktivt
title: "config"
---

# `openclaw config`

Config hjælpere: get/set/unset værdier efter sti. Kør uden en underkommando for at åbne
konfigurationsguiden (samme som `openclaw configure`).

## Eksempler

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Stier

Stier bruger punkt- eller klamme-notation:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Brug agentlistens indeks til at målrette en bestemt agent:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Værdier

Værdier fortolkes som JSON5 når det er muligt; ellers behandles de som strenge.
Brug `--json` for at kræve JSON5 parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Genstart gatewayen efter ændringer.
