---
summary: "CLI reference for `activi config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `activi config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `activi configure`).

## Examples

```bash
activi config get browser.executablePath
activi config set browser.executablePath "/usr/bin/google-chrome"
activi config set agents.defaults.heartbeat.every "2h"
activi config set agents.list[0].tools.exec.node "node-id-or-name"
activi config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
activi config get agents.defaults.workspace
activi config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
activi config get agents.list
activi config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--strict-json` to require JSON5 parsing. `--json` remains supported as a legacy alias.

```bash
activi config set agents.defaults.heartbeat.every "0m"
activi config set gateway.port 19001 --strict-json
activi config set channels.whatsapp.groups '["*"]' --strict-json
```

Restart the gateway after edits.
