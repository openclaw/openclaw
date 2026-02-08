---
summary: "CLI-referentie voor `openclaw config` (configwaarden ophalen/instellen/verwijderen)"
read_when:
  - Je wilt config niet-interactief lezen of bewerken
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:06Z
---

# `openclaw config`

Config-hulpmiddelen: waarden ophalen/instellen/verwijderen op basis van pad. Voer uit zonder subopdracht om
de configuratiewizard te openen (hetzelfde als `openclaw configure`).

## Examples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Paths

Paden gebruiken punt- of haakjesnotatie:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Gebruik de agentlijst-index om een specifieke agent te targeten:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Waarden worden, waar mogelijk, als JSON5 geparseerd; anders worden ze als strings behandeld.
Gebruik `--json` om JSON5-parsing af te dwingen.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Herstart de Gateway na wijzigingen.
