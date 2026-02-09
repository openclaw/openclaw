---
summary: "CLI reference for `EasyHub config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `EasyHub config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `EasyHub configure`).

## Examples

```bash
EasyHub config get browser.executablePath
EasyHub config set browser.executablePath "/usr/bin/google-chrome"
EasyHub config set agents.defaults.heartbeat.every "2h"
EasyHub config set agents.list[0].tools.exec.node "node-id-or-name"
EasyHub config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
EasyHub config get agents.defaults.workspace
EasyHub config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
EasyHub config get agents.list
EasyHub config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
EasyHub config set agents.defaults.heartbeat.every "0m"
EasyHub config set gateway.port 19001 --json
EasyHub config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
