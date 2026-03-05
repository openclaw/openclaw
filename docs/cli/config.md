---
summary: "CLI reference for `openclaw config` (get/set/unset/file/validate)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `openclaw config`

Config helpers: get/set/unset/validate values by path and print the active
config file. Run without a subcommand to open
the configure wizard (same as `openclaw configure`).

## Write safety model

Config writes use a transactional pipeline:

1. `prepare` (isolated validation in a staging file)
2. `commit` (write to active config path)
3. `verify` (re-read and validate committed snapshot)
4. `rollback` (restore pre-write snapshot on verify failure)

If a write fails, OpenClaw reports transaction details (stage, rollback status,
and issues when available). Failed writes do not intentionally leave a broken
committed config on disk.

## Examples

```bash
openclaw config file
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
openclaw config validate
openclaw config validate --json
```

## Paths

Paths use dot or bracket notation:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--strict-json` to require JSON5 parsing. `--json` remains supported as a legacy alias.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.whatsapp.groups '["*"]' --strict-json
```

## Subcommands

- `config file`: Print the active config file path (resolved from `OPENCLAW_CONFIG_PATH` or default location).

## Apply changes

After edits, restart the gateway to apply restart-scoped fields (`gateway.*`,
`plugins`, etc.). Restart now includes config preflight and backup recovery
attempts before proceeding.

## Validate

Validate the current config against the active schema without starting the
gateway.

```bash
openclaw config validate
openclaw config validate --json
```
