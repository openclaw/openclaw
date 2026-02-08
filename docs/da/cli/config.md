---
summary: "CLI-reference for `openclaw config` (hent/angiv/fjern konfigurationsværdier)"
read_when:
  - Du vil læse eller redigere konfiguration ikke-interaktivt
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:55Z
---

# `openclaw config`

Konfigurationshjælpere: hent/angiv/fjern værdier efter sti. Kør uden en underkommando for at åbne opsætningsguiden
(det samme som `openclaw configure`).

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

Værdier parses som JSON5, når det er muligt; ellers behandles de som strenge.
Brug `--json` for at kræve JSON5-parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Genstart gatewayen efter ændringer.
