---
summary: "CLI-Referenz für `openclaw config` (Config-Werte abrufen/setzen/entfernen)"
read_when:
  - Sie Konfigurationen nicht interaktiv lesen oder bearbeiten möchten
title: "config"
---

# `openclaw config`

Konfigurationshilfen: Werte nach Pfad abrufen/setzen/entfernen. Ohne Unterbefehl ausführen, um
den Konfigurationsassistenten zu öffnen (gleich wie `openclaw configure`).

## Beispiele

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Pfade

Pfade verwenden Punkt- oder Klammernotation:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Verwenden Sie den Agentenlistenindex, um einen bestimmten Agenten anzusprechen:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Werte

Werte werden, wenn möglich, als JSON5 geparst; andernfalls werden sie als Strings behandelt.
Verwenden Sie `--json`, um JSON5-Parsing zu erzwingen.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Starten Sie das Gateway nach Änderungen neu.
