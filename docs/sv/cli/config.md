---
summary: "CLI-referens för `openclaw config` (get/set/unset konfigvärden)"
read_when:
  - Du vill läsa eller redigera konfig icke-interaktivt
title: "konfig"
---

# `openclaw config`

Config helpers: get/set/unset values by path. Kör utan ett underkommando för att öppna
konfigurationsguiden (samma som `openclaw configure`).

## Exempel

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Sökvägar

Sökvägar använder punkt- eller hakparentesnotation:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Använd agentlistans index för att rikta in dig på en specifik agent:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Värden

Värden tolkas som JSON5 när det är möjligt, annars behandlas de som strängar.
Använd `--json` för att kräva JSON5 parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Starta om Gateway efter ändringar.
