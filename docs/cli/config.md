---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw config` (get/set/unset config values)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to read or edit config non-interactively（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "config"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw config`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config helpers: get/set/unset values by path. Run without a subcommand to open（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the configure wizard (same as `openclaw configure`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get browser.executablePath（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set browser.executablePath "/usr/bin/google-chrome"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set agents.defaults.heartbeat.every "2h"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config unset tools.web.search.apiKey（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paths use dot or bracket notation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.defaults.workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.list[0].id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the agent list index to target a specific agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Values are parsed as JSON5 when possible; otherwise they are treated as strings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--json` to require JSON5 parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set agents.defaults.heartbeat.every "0m"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.port 19001 --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set channels.whatsapp.groups '["*"]' --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the gateway after edits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
