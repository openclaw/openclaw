---
name: mcporter
description: Manage and call MCP servers (list, call, auth, daemon).
metadata: {"clawdis":{"requires":{"bins":["mcporter"]},"install":[{"id":"node","kind":"node","package":"mcporter","bins":["mcporter"],"label":"Install mcporter (node)"}]}}
---

# mcporter

Use `mcporter` to list MCP servers and call tools.

Quick start
- `mcporter list`
- `mcporter list <server> --schema`
- `mcporter call <server.tool> arg=value`

Auth + lifecycle
- OAuth: `mcporter auth <server>`
- Daemon: `mcporter daemon status|start|stop`

Ad-hoc servers
- HTTP: `mcporter list --http-url https://host/mcp --name <name>`
- STDIO: `mcporter call --stdio "bun run ./server.ts" --name <name>`

Notes
- Config sources: `~/.mcporter/mcporter.json[c]` and `config/mcporter.json`.
- Prefer `--json` when you need machine-readable output.
