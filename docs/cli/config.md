---
summary: "CLI reference for `dna config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
---

# `dna config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `dna configure`).

## Examples

```bash
dna config get browser.executablePath
dna config set browser.executablePath "/usr/bin/google-chrome"
dna config set agents.defaults.heartbeat.every "2h"
dna config set agents.list[0].tools.exec.node "node-id-or-name"
dna config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
dna config get agents.defaults.workspace
dna config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
dna config get agents.list
dna config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
dna config set agents.defaults.heartbeat.every "0m"
dna config set gateway.port 19001 --json
dna config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
